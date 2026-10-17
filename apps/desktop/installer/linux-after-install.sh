#!/bin/bash
# electron-builder's default after-install (app-builder-lib 26.15.3
# templates/linux/after-install.tpl) plus one addition: put the dsh CLI launcher on PATH.
#
# The package carries its own launcher at
#   /opt/DeepSeek Harness/resources/runtime/cli/bin/dsh
# (that shell script adapts to the macOS .app and the Linux layout), but the deb payload places
# nothing under /usr/bin. Without the symlink below a terminal cannot reach dsh, and headless
# driving is a primary use of this product.

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# dsh CLI: the launcher resolves its own location, so a link under /usr/bin suffices. Register it
# with update-alternatives like the application binary above rather than with a bare `ln -sf`:
# overwriting and later deleting a file another package owns would break that package.
if [ -e '/opt/${sanitizedProductName}/resources/runtime/cli/bin/dsh' ]; then
    if type update-alternatives >/dev/null 2>&1; then
        update-alternatives --install '/usr/bin/dsh' 'dsh' '/opt/${sanitizedProductName}/resources/runtime/cli/bin/dsh' 100 || ln -sf '/opt/${sanitizedProductName}/resources/runtime/cli/bin/dsh' '/usr/bin/dsh'
    else
        ln -sf '/opt/${sanitizedProductName}/resources/runtime/cli/bin/dsh' '/usr/bin/dsh'
    fi
else
    echo "warning: dsh CLI launcher missing, skipping /usr/bin/dsh" >&2
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install apparmor profile. (Ubuntu 24+)
# First check if the version of AppArmor running on the device supports our profile.
# This is in order to keep backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we just skip installing the profile since the app runs fine without it on 22.04.
#
# Those apparmor_parser flags are akin to performing a dry run of loading a profile.
# https://wiki.debian.org/AppArmor/HowToUse#Dumping_profiles
#
# Unfortunately, at the moment AppArmor doesn't have a good story for backwards compatibility.
# https://askubuntu.com/questions/1517272/writing-a-backwards-compatible-apparmor-profile
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Updating the current AppArmor profile is not possible and probably not meaningful in a chroot'ed environment.
    # Use cases are for example environments where images for clients are maintained.
    # There, AppArmor might correctly be installed, but live updating makes no sense.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      # Extra flags taken from dh_apparmor:
      # > By using '-W -T' we ensure that any abstraction updates are also pulled in.
      # https://gitlab.com/apparmor/apparmor/-/blob/3.0/AppArmorProfileManifest
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi
