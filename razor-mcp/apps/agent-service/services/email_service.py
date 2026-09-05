"""Email delivery (SMTP) — human OTPs and account verification codes.

Behavior matrix:
  * SMTP configured  -> real email via smtplib (stdlib; no new deps).
  * SMTP unconfigured-> the code is logged server-side AND (DEV_MODE only)
    returned in the API response so demos complete without mail infra.
    When DEV_MODE=false and SMTP is unset, codes are ONLY logged — the response
    never leaks them.

Every message is a small HTML email (dark theme to match the console).
"""
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from config import config


def _wrap(title: str, body_html: str) -> str:
    return f"""
    <div style="font-family:Inter,Segoe UI,Arial,sans-serif;background:#0f172a;padding:32px;border-radius:16px;max-width:520px;margin:auto">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
        <div style="width:36px;height:36px;border-radius:10px;background:#10b98122;color:#34d399;display:flex;align-items:center;justify-content:center;font-weight:900">RZ</div>
        <div>
          <div style="color:#e2e8f0;font-weight:700;letter-spacing:.04em">Razor-MCP</div>
          <div style="color:#64748b;font-size:11px">autonomous commerce console</div>
        </div>
      </div>
      <h2 style="color:#f1f5f9;font-size:18px;margin:0 0 12px">{title}</h2>
      <div style="color:#cbd5e1;font-size:14px;line-height:1.6">{body_html}</div>
      <p style="color:#475569;font-size:11px;margin-top:24px">Razorpay TEST MODE — no real funds move. If you did not request this, ignore the email.</p>
    </div>"""


def send_email(to: str, subject: str, html: str) -> bool:
    """Send one email. Returns True on success; False (never raises) otherwise."""
    if not config.smtp_configured:
        print(f"[email] SMTP not configured — would send to {to}: {subject}")
        return False
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = config.SMTP_FROM
        msg["To"] = to
        msg.attach(MIMEText(html, "html"))
        with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=10) as server:
            if config.SMTP_USE_TLS:
                server.starttls()
            if config.SMTP_USER:
                server.login(config.SMTP_USER, config.SMTP_PASSWORD)
            server.sendmail(config.SMTP_FROM, [to], msg.as_string())
        return True
    except Exception as err:  # noqa: BLE001
        print(f"[email] send failed to {to}: {err}")
        return False


def send_verification_email(to: str, code: str) -> bool:
    html = _wrap(
        "Verify your email",
        f"""
        <p>Use this one-time code to verify your Razor-MCP account:</p>
        <div style="font-family:monospace;font-size:26px;letter-spacing:.5em;color:#34d399;font-weight:800;background:#062f24;border:1px dashed #10b98166;border-radius:12px;padding:14px 18px;text-align:center;margin:16px 0">{code}</div>
        <p style="color:#64748b;font-size:12px">The code expires in 10 minutes.</p>""",
    )
    return send_email(to, "[Razor-MCP] Verify your email", html)


def send_purchase_otp_email(to: str, code: str, amount_inr: str, order_number: str) -> bool:
    html = _wrap(
        "Payment approval required",
        f"""
        <p>A purchase of <b style="color:#fbbf24">{amount_inr}</b> (order <span style="font-family:monospace">{order_number}</span>)
        exceeds the autonomous spend limit, so it needs your approval.</p>
        <div style="font-family:monospace;font-size:26px;letter-spacing:.5em;color:#fbbf24;font-weight:800;background:#3a2b06;border:1px dashed #f59e0b66;border-radius:12px;padding:14px 18px;text-align:center;margin:16px 0">{code}</div>
        <p style="color:#64748b;font-size:12px">Enter this code in the console OTP dialog. It expires in 5 minutes; 3 wrong attempts reject the transaction.</p>""",
    )
    return send_email(to, "[Razor-MCP] OTP to approve your payment", html)
