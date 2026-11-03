"""Upload a FIT file to Garmin Connect using the maintained `garminconnect`
library (the same one used to mint the token store).

Why Python for this one step: Garmin's 2026 auth changes (Cloudflare WAF + the
DI-token scheme) are handled by `garminconnect`, whose token store format is not
compatible with the Node garmin-connect library. The Node service shells out to
this script for the single upload call.

Usage:  python garmin_upload.py <fit_path> <tokenstore_dir>

Prints exactly one machine-readable line, prefixed with RESULT:, e.g.
  RESULT:{"status": "uploaded", "uploadId": 123, "httpStatus": 200}
  RESULT:{"status": "duplicate"}
  RESULT:{"status": "auth_error", "error": "..."}   (exit 3)
  RESULT:{"status": "error", "error": "..."}         (exit 4)
"""

import fcntl
import json
import os
import sys


def out(payload):
    print("RESULT:" + json.dumps(payload))


def main():
    if len(sys.argv) < 3:
        out({"status": "error", "error": "usage: garmin_upload.py <fit> <tokenstore>"})
        sys.exit(2)

    fit_path, tokenstore = sys.argv[1], sys.argv[2]

    # A refresh can rotate the refresh token and rewrites garmin_tokens.json in
    # place, so two processes sharing this token store must not log in at once:
    # one would read a half-written file or keep a token Garmin just retired.
    # Any other tool that uses the same store should take this same lock.
    fd = os.open(os.path.join(tokenstore, ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        upload(fit_path, tokenstore)
    finally:
        os.close(fd)


def upload(fit_path, tokenstore):
    from garminconnect import Garmin

    # Token-only login: loads the stored DI tokens and refreshes them as needed.
    # No password/MFA at runtime (and thus no SSO 429 risk) unless tokens expired.
    try:
        g = Garmin()
        g.login(tokenstore)
    except Exception as e:  # noqa: BLE001
        out({"status": "auth_error", "error": str(e)})
        sys.exit(3)

    try:
        res = g.upload_activity(fit_path)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "409" in msg or "conflict" in msg.lower() or "already" in msg.lower():
            out({"status": "duplicate"})
            return
        out({"status": "error", "error": msg})
        sys.exit(4)

    # Interpret a variety of possible return shapes (Response or parsed dict).
    status_code = getattr(res, "status_code", None)
    body = None
    if hasattr(res, "json"):
        try:
            body = res.json()
        except Exception:  # noqa: BLE001
            body = None
    elif isinstance(res, (dict, list)):
        body = res

    if status_code == 409:
        out({"status": "duplicate"})
        return

    upload_id = None
    if isinstance(body, dict):
        detailed = body.get("detailedImportResult") or {}
        upload_id = detailed.get("uploadId")

    out({"status": "uploaded", "uploadId": upload_id, "httpStatus": status_code})


if __name__ == "__main__":
    main()
