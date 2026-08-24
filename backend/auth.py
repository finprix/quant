"""QUANT VECTOR authentication core — standard library only.

Security model
--------------
* The developer credential comes exclusively from the backend
  environment (never from the frontend, never committed):
      MARKETDNA_DEV_PIN_HASH       (scrypt: "scrypt$n$r$p$salt_hex$hash_hex")
      MARKETDNA_SESSION_SECRET     (HMAC-SHA256 signing key)
* PINs are hashed with hashlib.scrypt (memory-hard KDF) and verified
  with hmac.compare_digest (timing-safe).
* Sessions are HMAC-SHA256-signed tokens carried in an HTTP-only cookie.
  The browser can never forge one without the server secret. The token
  subject is the fixed role id "developer".
* A lightweight sliding-window rate limiter throttles repeated failed
  logins per client IP.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from collections import defaultdict, deque

SESSION_COOKIE = "marketdna_session"

_SCRYPT_N = 16384
_SCRYPT_R = 8
_SCRYPT_P = 1
_DKLEN = 32

_DEFAULT_MAX_AGE = 12 * 60 * 60  # 12 hours


# --------------------------------------------------------------------------
# .env loading (tiny, dependency-free; existing environment always wins)
# --------------------------------------------------------------------------

def load_dotenv(path=None):
    """Load KEY=VALUE pairs from the backend .env file into os.environ."""
    if path is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.isfile(path):
        return []
    loaded = []
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            for raw in handle:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
                    loaded.append(key)
    except OSError:
        return []
    return loaded


def _env(name, default=None):
    return os.environ.get(name, default)


def _env_int(name, default):
    try:
        return int(_env(name, "") or default)
    except ValueError:
        return default


def _env_bool(name, default):
    raw = (_env(name, "") or "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


# --------------------------------------------------------------------------
# Password hashing (scrypt) — format: scrypt$n$r$p$salt_hex$hash_hex
# --------------------------------------------------------------------------

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt,
        n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=_DKLEN,
    )
    return "scrypt${}${}${}${}${}".format(
        _SCRYPT_N, _SCRYPT_R, _SCRYPT_P, salt.hex(), digest.hex(),
    )


def verify_password(password: str, stored: str) -> bool:
    """Timing-safe verification; malformed hashes simply fail."""
    try:
        scheme, n, r, p, salt_hex, hash_hex = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = bytes.fromhex(hash_hex)
        candidate = hashlib.scrypt(
            password.encode("utf-8"), salt=bytes.fromhex(salt_hex),
            n=int(n), r=int(r), p=int(p), dklen=len(expected),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(candidate, expected)


# --------------------------------------------------------------------------
# Signed session tokens (HMAC-SHA256 over a compact JSON payload)
# --------------------------------------------------------------------------

def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64url(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)


def _secret_key() -> bytes:
    explicit = _env("MARKETDNA_SESSION_SECRET")
    if explicit:
        return explicit.encode("utf-8")
    # Ephemeral fallback: sessions die on restart rather than being forgeable
    # with a known empty secret. Set MARKETDNA_SESSION_SECRET for sessions
    # that survive restarts/deployments.
    global _EPHEMERAL_SECRET
    if _EPHEMERAL_SECRET is None:
        _EPHEMERAL_SECRET = secrets.token_bytes(32)
    return _EPHEMERAL_SECRET


_EPHEMERAL_SECRET = None


def create_session_token(username: str, max_age: int = None) -> str:
    max_age = max_age if max_age is not None else _env_int(
        "MARKETDNA_SESSION_MAX_AGE", _DEFAULT_MAX_AGE
    )
    payload = {"v": 1, "sub": username, "exp": int(time.time()) + max_age}
    body = _b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = hmac.new(_secret_key(), body.encode("ascii"), hashlib.sha256).digest()
    return f"{body}.{_b64url(signature)}"


def read_session_token(token) -> str | None:
    """Return the username for a valid, unexpired token, else None."""
    if not token or "." not in token:
        return None
    body, _, sig_text = token.rpartition(".")
    try:
        expected = _unb64url(sig_text)
        candidate = hmac.new(
            _secret_key(), body.encode("ascii"), hashlib.sha256
        ).digest()
    except (ValueError, TypeError):
        return None
    if not hmac.compare_digest(candidate, expected):
        return None
    try:
        payload = json.loads(_unb64url(body))
        username = payload["sub"]
        expires = float(payload["exp"])
    except (ValueError, KeyError, TypeError):
        return None
    if not isinstance(username, str) or time.time() > expires:
        return None
    return username


# --------------------------------------------------------------------------
# Configuration introspection
# --------------------------------------------------------------------------

def auth_configured() -> bool:
    return bool(_env("MARKETDNA_DEV_PIN_HASH"))


def configured_pin_hash():
    return _env("MARKETDNA_DEV_PIN_HASH")


def cookie_kwargs() -> dict:
    """Cookie options honouring deployment configuration."""
    return {
        "key": SESSION_COOKIE,
        "max_age": _env_int("MARKETDNA_SESSION_MAX_AGE", _DEFAULT_MAX_AGE),
        "httponly": True,
        "samesite": (_env("MARKETDNA_COOKIE_SAMESITE") or "lax").strip().lower(),
        "secure": _env_bool("MARKETDNA_COOKIE_SECURE", False),
        "path": "/",
    }


# --------------------------------------------------------------------------
# Login rate limiting — sliding window per (client ip, username)
# --------------------------------------------------------------------------

class LoginRateLimiter:
    def __init__(self, max_attempts: int = 5, window_seconds: float = 60.0):
        self.max_attempts = max_attempts
        self.window = window_seconds
        self._failures = defaultdict(deque)

    def blocked(self, key: str) -> bool:
        self._gc()
        attempts = self._failures.get(key)
        if not attempts:
            return False
        cutoff = time.monotonic() - self.window
        while attempts and attempts[0] < cutoff:
            attempts.popleft()
        return len(attempts) >= self.max_attempts

    def record_failure(self, key: str) -> None:
        self._failures[key].append(time.monotonic())

    def reset(self, key: str) -> None:
        self._failures.pop(key, None)

    def retry_after(self, key: str) -> int:
        attempts = self._failures.get(key) or deque()
        if not attempts:
            return self.window
        oldest = attempts[0]
        remaining = (oldest + self.window) - time.monotonic()
        return max(1, int(remaining) + 1)

    def _gc(self) -> None:
        if len(self._failures) < 256:
            return
        cutoff = time.monotonic() - self.window
        stale = [
            key for key, dq in self._failures.items()
            if not dq or dq[-1] < cutoff
        ]
        for key in stale:
            self._failures.pop(key, None)


login_rate_limiter = LoginRateLimiter(
    max_attempts=_env_int("MARKETDNA_LOGIN_MAX_ATTEMPTS", 5),
    window_seconds=float(_env_int("MARKETDNA_LOGIN_WINDOW_SECONDS", 60)),
)
