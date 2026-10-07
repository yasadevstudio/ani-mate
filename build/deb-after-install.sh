#!/bin/bash
# YASA PRESENTS
# Runs as root after `dpkg -i` / `apt install` of the ANI-MATE .deb.
#
# WHY THIS EXISTS. Electron ships a setuid helper, chrome-sandbox, and REFUSES TO START
# rather than run unsandboxed if it is not root-owned with mode 4755:
#
#   FATAL:setuid_sandbox_host.cc(163)] The SUID sandbox helper binary was found, but is not
#   configured correctly. Rather than run without sandboxing I'm aborting now.
#
# electron-builder does not emit this step for deb targets, so every install needed the two
# commands below typed by hand, and the app looked broken until they were. Passing
# --no-sandbox instead would "fix" it by turning off a security boundary; this keeps it on.
set -e
SANDBOX="/opt/ANI-MATE/chrome-sandbox"
if [ -f "$SANDBOX" ]; then
    chown root:root "$SANDBOX"
    chmod 4755 "$SANDBOX"
fi
