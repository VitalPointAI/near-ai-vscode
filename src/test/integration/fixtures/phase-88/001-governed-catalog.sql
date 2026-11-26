-- Phase 88 synthetic tracer. Apply only through the owner migration connection.
BEGIN;

CREATE ROLE phase88_owner NOLOGIN NOINHERIT;
CREATE ROLE phase88_verifier NOLOGIN NOINHERIT;
CREATE ROLE phase88_writer NOLOGIN NOINHERIT;
CREATE ROLE phase88_app NOLOGIN NOINHERIT;

CREATE SCHEMA phase88 AUTHORIZATION phase88_owner;
CREATE SCHEMA phase88_private AUTHORIZATION phase88_owner;
CREATE SCHEMA phase88_crypto AUTHORIZATION phase88_owner;
REVOKE ALL ON SCHEMA phase88, phase88_private, phase88_crypto FROM PUBLIC;
CREATE EXTENSION pgcrypto WITH SCHEMA phase88_crypto;

SET LOCAL ROLE phase88_owner;
CREATE TABLE phase88_private.verifier_key (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  key bytea NOT NULL CHECK (octet_length(key) = 32)
);
CREATE TABLE phase88_private.clearance (
  backend integer PRIMARY KEY,
  transaction xid8 NOT NULL,
  tenant text NOT NULL,
  subject text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('read', 'record')),
  policy_revision text NOT NULL,
  expires_at timestamptz NOT NULL,
  mission text NOT NULL,
  source_id text NOT NULL,
  label jsonb NOT NULL,
  fact_sha256 bytea CHECK (octet_length(fact_sha256) = 32),
  CHECK ((purpose = 'record') = (fact_sha256 IS NOT NULL))
);

CREATE TABLE phase88.catalogue (
  tenant text NOT NULL,
  mission text NOT NULL,
  source_id text NOT NULL,
  item_id text NOT NULL,
  source_version text NOT NULL,
  policy_revision text NOT NULL,
  name text NOT NULL,
  label jsonb NOT NULL,
  PRIMARY KEY (tenant, mission, source_id, item_id)
);
CREATE TABLE phase88.receipt (
  tenant text NOT NULL,
  mission text NOT NULL,
  source_id text NOT NULL,
  item_id text NOT NULL,
  source_version text NOT NULL,
  observation_hash bytea NOT NULL,
  PRIMARY KEY (tenant, mission, source_id, item_id, source_version)
);
CREATE TABLE phase88.checkpoint (
  tenant text NOT NULL,
  mission text NOT NULL,
  source_id text NOT NULL,
  source_version text NOT NULL,
  PRIMARY KEY (tenant, mission, source_id)
);
CREATE TABLE phase88.signed_fact (
  tenant text NOT NULL,
  mission text NOT NULL,
  source_id text NOT NULL,
  item_id text NOT NULL,
  source_version text NOT NULL,
  fact jsonb NOT NULL,
  PRIMARY KEY (tenant, mission, source_id, item_id, source_version)
);
CREATE TABLE phase88.outbox (
  tenant text NOT NULL,
  mission text NOT NULL,
  source_id text NOT NULL,
  item_id text NOT NULL,
  source_version text NOT NULL,
  PRIMARY KEY (tenant, mission, source_id, item_id, source_version),
  FOREIGN KEY (tenant, mission, source_id, item_id, source_version)
    REFERENCES phase88.signed_fact (tenant, mission, source_id, item_id, source_version)
);

ALTER TABLE phase88_private.verifier_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE phase88_private.verifier_key FORCE ROW LEVEL SECURITY;
ALTER TABLE phase88_private.clearance ENABLE ROW LEVEL SECURITY;
ALTER TABLE phase88_private.clearance FORCE ROW LEVEL SECURITY;
CREATE POLICY verifier_key_read ON phase88_private.verifier_key FOR SELECT TO phase88_verifier USING (true);
CREATE POLICY clearance_verifier ON phase88_private.clearance TO phase88_verifier USING (true) WITH CHECK (true);
GRANT USAGE ON SCHEMA phase88 TO phase88_app;
GRANT USAGE ON SCHEMA phase88_private, phase88_crypto TO phase88_verifier, phase88_writer;
GRANT SELECT ON phase88_private.verifier_key TO phase88_verifier;
GRANT SELECT, INSERT, UPDATE ON phase88_private.clearance TO phase88_verifier;

-- Only the verifier role sees trusted context. Roles have no login and execution is granted by function.
GRANT USAGE, CREATE ON SCHEMA phase88, phase88_private TO phase88_verifier;
GRANT USAGE, CREATE ON SCHEMA phase88 TO phase88_writer;
SET LOCAL ROLE phase88_verifier;

CREATE FUNCTION phase88.install_clearance(claims text, supplied_mac bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  parts text[];
  expected_mac bytea;
  verifier_key bytea;
  expires timestamptz;
  installed integer;
  scoped_label jsonb;
BEGIN
  IF claims IS NULL OR octet_length(claims) > 4096 OR octet_length(supplied_mac) IS DISTINCT FROM 32 THEN
    RETURN false;
  END IF;
  parts := string_to_array(claims, E'\n');
  IF cardinality(parts) NOT IN (12, 13) OR parts[1] <> 'phase88-clearance-v1'
    OR parts[4] <> 'phase88-catalogue' OR parts[5] NOT IN ('read', 'record')
    OR (parts[5] = 'read' AND cardinality(parts) <> 12)
    OR (parts[5] = 'record' AND (cardinality(parts) <> 13 OR parts[13] !~ '^[0-9a-f]{64}$'))
    OR EXISTS (SELECT 1 FROM unnest(ARRAY[parts[2], parts[3], parts[6], parts[8], parts[9]]) AS token
      WHERE token !~ '^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$')
    OR parts[7] !~ '^[1-9][0-9]{0,10}$'
    OR parts[10] IS DISTINCT FROM pg_backend_pid()::text
    OR parts[11] IS DISTINCT FROM pg_current_xact_id_if_assigned()::text
    OR NOT (parts[12] IS JSON OBJECT WITH UNIQUE KEYS) THEN
    RETURN false;
  END IF;

  expires := to_timestamp(parts[7]::bigint);
  IF expires <= clock_timestamp() OR expires > clock_timestamp() + interval '60 seconds' THEN
    RETURN false;
  END IF;
  scoped_label := parts[12]::jsonb;
  IF NOT scoped_label ?& ARRAY['scale', 'level', 'compartments', 'releasability', 'handling']
    OR scoped_label - ARRAY['scale', 'level', 'compartments', 'releasability', 'handling'] <> '{}'::jsonb
    OR jsonb_typeof(scoped_label->'scale') <> 'string' OR jsonb_typeof(scoped_label->'level') <> 'string'
    OR jsonb_typeof(scoped_label->'compartments') <> 'array' OR jsonb_typeof(scoped_label->'releasability') <> 'array'
    OR jsonb_typeof(scoped_label->'handling') <> 'array' THEN
    RETURN false;
  END IF;

  SELECT k.key INTO verifier_key FROM phase88_private.verifier_key AS k WHERE k.singleton;
  IF verifier_key IS NULL THEN
    RETURN false;
  END IF;
  expected_mac := phase88_crypto.hmac(convert_to(claims, 'UTF8'), verifier_key, 'sha256');
  -- Compare random-looking keyed values so bytea's ordinary equality is not a prefix oracle for the MAC.
  IF phase88_crypto.hmac(expected_mac, verifier_key, 'sha256') <> phase88_crypto.hmac(supplied_mac, verifier_key, 'sha256') THEN
    RETURN false;
  END IF;

  INSERT INTO phase88_private.clearance AS installed_context
    (backend, transaction, tenant, subject, purpose, policy_revision, expires_at, mission, source_id, label, fact_sha256)
  VALUES (pg_backend_pid(), pg_current_xact_id(), parts[2], parts[3], parts[5], parts[6], expires, parts[8], parts[9], scoped_label,
    CASE WHEN parts[5] = 'record' THEN decode(parts[13], 'hex') END)
  ON CONFLICT (backend) DO UPDATE
    SET transaction = excluded.transaction, tenant = excluded.tenant, subject = excluded.subject, purpose = excluded.purpose,
        policy_revision = excluded.policy_revision, expires_at = excluded.expires_at, mission = excluded.mission,
        source_id = excluded.source_id, label = excluded.label, fact_sha256 = excluded.fact_sha256
    WHERE installed_context.transaction <> excluded.transaction;
  GET DIAGNOSTICS installed = ROW_COUNT;
  RETURN installed = 1;
END;
$$;

CREATE FUNCTION phase88_private.binding() RETURNS SETOF phase88_private.clearance
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM phase88_private.clearance
  WHERE backend = pg_backend_pid() AND transaction = pg_current_xact_id_if_assigned() AND expires_at > clock_timestamp()
$$;

CREATE FUNCTION phase88.can_read(row_tenant text, row_mission text, row_source text, row_revision text, row_label jsonb)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM phase88_private.binding() AS binding
    WHERE binding.purpose = 'read' AND binding.tenant = row_tenant AND binding.mission = row_mission
      AND binding.source_id = row_source AND binding.policy_revision = row_revision AND binding.label = row_label
  )
$$;

REVOKE ALL ON FUNCTION phase88.install_clearance(text, bytea), phase88_private.binding(),
  phase88.can_read(text, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION phase88.install_clearance(text, bytea), phase88.can_read(text, text, text, text, jsonb) TO phase88_app;
GRANT EXECUTE ON FUNCTION phase88_private.binding() TO phase88_writer;

SET LOCAL ROLE phase88_owner;
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['catalogue', 'receipt', 'checkpoint', 'signed_fact', 'outbox'] LOOP
    EXECUTE format('ALTER TABLE phase88.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE phase88.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY writer ON phase88.%I TO phase88_writer USING (true) WITH CHECK (true)', table_name);
  END LOOP;
END;
$$;
CREATE POLICY catalogue_reader ON phase88.catalogue FOR SELECT TO phase88_app USING (
  phase88.can_read(tenant, mission, source_id, policy_revision, label)
);
GRANT SELECT ON phase88.catalogue TO phase88_app;
GRANT SELECT, INSERT, UPDATE ON phase88.catalogue, phase88.checkpoint TO phase88_writer;
GRANT SELECT, INSERT ON phase88.receipt TO phase88_writer;
GRANT INSERT ON phase88.signed_fact, phase88.outbox TO phase88_writer;

SET LOCAL ROLE phase88_writer;
CREATE FUNCTION phase88.record_observation(item_id text, version text, name text, label jsonb, signed_fact jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  scope phase88_private.clearance;
  fingerprint bytea;
  previous_hash bytea;
BEGIN
  SELECT * INTO scope FROM phase88_private.binding();
  IF NOT FOUND OR scope.purpose <> 'record' OR label IS DISTINCT FROM scope.label THEN
    RAISE EXCEPTION 'Observation has no verified write scope' USING ERRCODE = '42501';
  END IF;
  IF item_id IS NULL OR item_id !~ '^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$'
    OR version IS NULL OR version !~ '^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$'
    OR name IS NULL OR octet_length(name) NOT BETWEEN 1 AND 1024 OR name ~ '[[:cntrl:]]'
    OR jsonb_typeof(signed_fact) IS DISTINCT FROM 'object' OR octet_length(signed_fact::text) > 16384
    OR jsonb_typeof(signed_fact->'sig') IS DISTINCT FROM 'string' OR signed_fact->>'sig' = ''
    -- The fixture issuer MAC covers the digest of the actual envelope, including its signature.
    OR phase88_crypto.digest(convert_to(signed_fact::text, 'UTF8'), 'sha256') IS DISTINCT FROM scope.fact_sha256
    OR signed_fact->'payload' IS DISTINCT FROM jsonb_build_object(
      'operation', 'record', 'tenant', scope.tenant, 'mission', scope.mission, 'policyRevision', scope.policy_revision,
      'sourceId', scope.source_id, 'itemId', item_id, 'sourceVersion', version, 'name', name, 'label', label) THEN
    RAISE EXCEPTION 'Invalid observation or signed fact binding' USING ERRCODE = '22023';
  END IF;

  fingerprint := phase88_crypto.digest(convert_to(jsonb_build_array(item_id, version, name, label, scope.policy_revision)::text, 'UTF8'), 'sha256');
  INSERT INTO phase88.receipt VALUES (scope.tenant, scope.mission, scope.source_id, item_id, version, fingerprint)
    ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT receipt.observation_hash INTO previous_hash FROM phase88.receipt AS receipt
    WHERE receipt.tenant = scope.tenant AND receipt.mission = scope.mission AND receipt.source_id = scope.source_id
      AND receipt.item_id = record_observation.item_id AND receipt.source_version = version;
    IF previous_hash IS DISTINCT FROM fingerprint THEN
      RAISE EXCEPTION 'Observation identity already has different metadata' USING ERRCODE = '22023';
    END IF;
    RETURN 'duplicate';
  END IF;

  INSERT INTO phase88.catalogue VALUES (scope.tenant, scope.mission, scope.source_id, item_id, version, scope.policy_revision, name, label)
    ON CONFLICT ON CONSTRAINT catalogue_pkey DO UPDATE SET source_version = excluded.source_version,
      policy_revision = excluded.policy_revision, name = excluded.name, label = excluded.label;
  INSERT INTO phase88.checkpoint VALUES (scope.tenant, scope.mission, scope.source_id, version)
    ON CONFLICT ON CONSTRAINT checkpoint_pkey DO UPDATE SET source_version = excluded.source_version;
  INSERT INTO phase88.signed_fact VALUES (scope.tenant, scope.mission, scope.source_id, item_id, version, signed_fact);
  INSERT INTO phase88.outbox VALUES (scope.tenant, scope.mission, scope.source_id, item_id, version);
  RETURN 'recorded';
END;
$$;
REVOKE ALL ON FUNCTION phase88.record_observation(text, text, text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION phase88.record_observation(text, text, text, jsonb, jsonb) TO phase88_app;

SET LOCAL ROLE phase88_owner;
REVOKE CREATE ON SCHEMA phase88 FROM phase88_writer, phase88_verifier;
REVOKE CREATE ON SCHEMA phase88_private FROM phase88_verifier;
COMMIT;
