#!/bin/bash
# electron-builder's default after-remove (app-builder-lib templates/linux/after-remove.tpl,
# 26.15.3) with one extension: dropping the /usr/bin/dsh link added by after-install.

# Delete the link to the binary
# update-alternatives --remove <name> <path>: 'path' must be the registered alternative binary,
# not the generic symlink — see https://man7.org/linux/man-pages/man1/update-alternatives.1
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

# dsh CLI: drop only this package's alternative, the same way the application binary above is
# removed. The launcher itself disappears with /opt, and a system with update-alternatives is
# never left with a bare `rm` that could delete a file another package owns.
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove 'dsh' '/opt/${sanitizedProductName}/resources/runtime/cli/bin/dsh' 2>/dev/null || true
else
    rm -f '/usr/bin/dsh'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove and unload apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  # Unload the profile from the running kernel before deleting the file so the
  # policy is not left enforced until the next reboot.  Mirror the chroot guard
  # used in the after-install script — live AppArmor operations are not
  # meaningful inside a chroot.
  # https://wiki.debian.org/AppArmor/HowToUse#Dumping_profiles
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi
