// The sidebar's one profile-readiness rule (G-61-7). It decides whether the project has a working NEAR AI profile, from the profile-status
// message the host already sends (on load, after setup and after a profile switch). Three things follow it: the Team section (team.js), the
// planning-file links (chat.css hides #project-links unless body data-profile is ready) and, once main is merged into Team Mode, PR #7's
// Connect NEAR AI panel (media/chat/setup.js). It keeps only the state name, in memory and on body data-profile; never a profile name or key.
//
// Merge note (main with 0.4.14 into Team Mode): keep this file as the rule. Make setup.js's welcomeState delegate to root.nearReadiness.welcomeState
// (or keep its copy, which src/test/sidebarReadiness.test.ts then compares case for case), and keep readiness.js before setup.js and chat.js in
// sidebarHtml (src/services/panelView.ts).
(function (root) {
  'use strict';

  /**
   * Which state the profile-status value gives, exactly as PR #7's setup.js welcomeState:
   * - 'no-folder': no folder is open (value.noWorkspace, sent from 0.4.14 on);
   * - 'ready': the selected profile works (its key was checked);
   * - 'choose': the selected profile needs its key checked again, or none is selected and one does not work;
   * - 'select': saved profiles all work, but none is selected for this project;
   * - 'connect': no saved profile (also a missing or malformed value).
   */
  function welcomeState(value) {
    if (value && value.noWorkspace === true) return 'no-folder';
    const profiles = (value && Array.isArray(value.profiles)) ? value.profiles.filter(Boolean) : [];
    const works = (item) => Boolean(item.validation) && item.validation.status === 'valid';
    const active = profiles.find((item) => item.profileId === value.activeProfileId);
    if (active) return works(active) ? 'ready' : 'choose';
    if (!profiles.length) return 'connect';
    return profiles.every(works) ? 'select' : 'choose';
  }

  /** True only when the value gives 'ready'. */
  function isReady(value) {
    return welcomeState(value) === 'ready';
  }

  // The last state, undefined before the first profile-status (which counts as not ready), and who wants to hear about changes.
  let last;
  const listeners = [];

  /** The last state, or undefined before the first profile-status. */
  function current() {
    return last;
  }

  /** Calls listener(state) after each profile-status. Returns a function that removes it. */
  function onChange(listener) {
    if (typeof listener !== 'function') return function () {};
    listeners.push(listener);
    return function () {
      const at = listeners.indexOf(listener);
      if (at !== -1) listeners.splice(at, 1);
    };
  }

  /** Follows the profile-status messages of `win`: each one sets doc.body's data-profile to the state and tells the listeners. */
  function track(win, doc) {
    win.addEventListener('message', (event) => {
      const message = (event && event.data) || {};
      if (message.type !== 'profile-status') return;
      last = welcomeState(message.value);
      if (doc && doc.body) doc.body.setAttribute('data-profile', last);
      for (const listener of listeners.slice()) listener(last);
    });
  }

  const api = Object.freeze({ welcomeState, isReady, track, current, onChange });
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.nearReadiness = api;
    if (root.document && typeof root.addEventListener === 'function') track(root, root.document);
  }
})(typeof window === 'undefined' ? globalThis : window);
