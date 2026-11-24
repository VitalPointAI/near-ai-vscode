# Session states

**What it is for.** Reading the state of a person's Sterling session and knowing what to do about it (DESIGN section 7, D-25, D-29). No state waits silently: each one either moves on by itself or shows why it stopped.

**Who does it.** Site operators, when someone reports a session that will not start or stopped.

**What you need.** kubectl (RKE2's). See sessions with `kubectl get sessions -n theia-cloud`, their pods with `kubectl get pods -n theia-cloud -l sterling-session`, and the reasons in the Theia Cloud operator's logs (`kubectl logs -n theia-cloud deploy/operator-deployment`).

| State | What it means | What to do |
|---|---|---|
| pooled | A pre-started session waiting for a person. Not used: the pool is 0 until Phase 48 measures it. | Nothing. |
| requested | The person asked for a session; the operator has the Session record. | Nothing; it moves to starting or refused. |
| refused | The site reached `maxInstances` (the sessions site file); no new session starts. | Raise `appDefinition.maxInstances` in the site folder's `sterling-sessions.yaml` if the nodes have room, then `install.mjs apply --release sterling-sessions`. The message the person sees is a Phase 46 or upstream item. |
| starting | The pod is being created and its workspace volume attached. | Nothing, unless it takes minutes: then look at the pod's events. |
| failed | The start timed out or the pod was refused, for example by the session environment policy (admission) or Pod Security. | The reason is in the Session's status, the pod's events and the operator's logs. Fix the cause; the person starts again. |
| identity | The workbench signs in to OpenBao for the person (Phase 46). | If it stays here, check OpenBao is unsealed (`install.mjs status`) and the person is enrolled (`enrolment.md`). |
| active | The person is working. | Nothing. |
| idle-warned | No activity for `notifyAfterMinutes`; the person sees a warning. | Nothing; activity returns it to active. |
| stopping | No activity for `sessionTimeoutMinutes` (the site file); the session is stopped. | Nothing. Both idle settings are provisional until Phase 48 measures them (D-11). |
| stopped | The session ended. The workspace volume is kept. | The person starts a new session and finds their workspace. |
