"""Generate local-login secrets and a Microsoft Authenticator QR code.

Run this yourself in a terminal so the password never enters chat, shell
history, or source control. Scan the generated QR image before deploying.
"""

from __future__ import annotations

from getpass import getpass
from pathlib import Path

from argon2 import PasswordHasher
import pyotp
import qrcode


PROJECT_ROOT = Path(__file__).resolve().parent.parent
QR_PATH = PROJECT_ROOT / ".streamlit" / "authenticator-setup.png"


def main() -> None:
    username = input("Choose a private username: ").strip()
    if not username:
        raise SystemExit("Username cannot be empty.")
    password = getpass("Choose a long, unique password: ")
    confirmation = getpass("Confirm password: ")
    if len(password) < 8:
        raise SystemExit("Use a password of at least 8 characters.")
    if password != confirmation:
        raise SystemExit("Passwords did not match.")

    totp_secret = pyotp.random_base32()
    provisioning_uri = pyotp.TOTP(totp_secret).provisioning_uri(name=username, issuer_name="ProgreSQL")
    qrcode.make(provisioning_uri).save(QR_PATH)

    print("\nPaste these three lines into .streamlit/secrets.toml, replacing its placeholders:\n")
    print(f'auth_username = "{username}"')
    print(f'auth_password_hash = "{PasswordHasher().hash(password)}"')
    print(f'auth_totp_secret = "{totp_secret}"')
    print(f"\nScan this QR image in Microsoft Authenticator: {QR_PATH}")
    print("Then delete the image. It contains your MFA secret.")


if __name__ == "__main__":
    main()
