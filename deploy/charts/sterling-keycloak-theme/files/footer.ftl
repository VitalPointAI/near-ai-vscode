<#-- The Sterling login theme's only override (D-76, AC-8). keycloak.v2's template.ftl calls this macro on every page built with
     registrationLayout, the passkey sign-in page among them, so your organization's system use notice is on screen before a person signs in.
     The text is the realm message sterlingSystemUseNotice, one per language, which deploy/keycloak/apply.mjs writes from the realm site file's
     systemUseNotice. A blank line starts a new paragraph. FreeMarker's HTML escaping stays on: the text is shown as typed and cannot add markup. -->
<#macro content>
  <div id="sterling-system-use-notice" role="note">
    <#list msg("sterlingSystemUseNotice")?split("\n\n") as paragraph>
      <#if paragraph?trim?has_content><p>${paragraph?trim}</p></#if>
    </#list>
  </div>
</#macro>
