/** Compiled into fork binaries; runtime configuration cannot re-enable installation. */
declare const __PLANNOTATOR_DISABLE_INSTALLER_UPDATES__: boolean;

export const INSTALLER_UPDATES_DISABLED =
  typeof __PLANNOTATOR_DISABLE_INSTALLER_UPDATES__ !== "undefined" && __PLANNOTATOR_DISABLE_INSTALLER_UPDATES__;

export const UPDATE_INSTALLATION_DISABLED_MESSAGE =
  "Installer updates are disabled in this build. Build a reviewed commit from https://github.com/cboone/plannotator, " +
  "verify the resulting binary, then replace the installed binary manually.";
