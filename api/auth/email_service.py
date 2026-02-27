"""
Email service for sending verification and password reset emails.

Uses SMTP (aiosmtplib) for sending.
In development mode (no SMTP configured), logs the code to console.

Moved from api/email_service.py to api/auth/email_service.py
"""

import structlog

from config.settings import settings

logger = structlog.get_logger()


async def _send_smtp(to_email: str, subject: str, body_html: str) -> bool:
    """Send an email via SMTP using aiosmtplib. Raises on failure."""
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    import aiosmtplib

    logger.info(
        "email_smtp_attempt",
        to=to_email,
        subject=subject,
        smtp_host=settings.smtp_host,
        smtp_port=settings.smtp_port,
        smtp_user=settings.smtp_user,
        email_from=settings.email_from,
    )

    msg = MIMEMultipart("alternative")
    msg["From"] = settings.email_from
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.attach(MIMEText(body_html, "html", "utf-8"))

    try:
        await aiosmtplib.send(
            msg,
            hostname=settings.smtp_host,
            port=settings.smtp_port,
            username=settings.smtp_user,
            password=settings.smtp_password,
            use_tls=False,
            start_tls=True,
        )
        logger.info("email_sent", to=to_email, subject=subject)
        return True
    except Exception as e:
        logger.error(
            "email_send_failed",
            to=to_email,
            subject=subject,
            smtp_host=settings.smtp_host,
            smtp_port=settings.smtp_port,
            smtp_user=settings.smtp_user,
            error=str(e),
            error_type=type(e).__name__,
        )
        raise


def _is_smtp_configured() -> bool:
    """Check if SMTP is properly configured."""
    return bool(settings.smtp_host and settings.smtp_user and settings.smtp_password)


async def send_set_password_email(
    to_email: str, user_name: str, set_password_token: str
) -> bool:
    """Send an email with a link to set the initial password."""
    base_url = settings.app_base_url
    subject = "IconsAI - Configure sua senha"
    body_html = f"""
    <html>
    <body style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Bem-vindo ao IconsAI, {user_name}!</h2>
        <p>Sua conta foi criada. Clique no botao abaixo para configurar sua senha:</p>
        <a href="{base_url}/set-password?token={set_password_token}"
           style="display: inline-block; background: #06b6d4; color: white; padding: 12px 24px;
                  border-radius: 8px; text-decoration: none; font-weight: bold;">
            Configurar Senha
        </a>
        <p style="margin-top: 16px; color: #666; font-size: 12px;">
            <strong>Este link expira em 24 horas.</strong>
        </p>
        <p style="margin-top: 8px; color: #999; font-size: 11px;">
            Se o botao nao funcionar, copie e cole este link no navegador:<br>
            {base_url}/set-password?token={set_password_token}
        </p>
        <hr>
        <p style="color: #666; font-size: 12px;">IconsAI - Inteligencia de Dados</p>
    </body>
    </html>
    """

    if not _is_smtp_configured():
        logger.info(
            "email_dev_mode",
            to=to_email,
            subject=subject,
            set_password_token=set_password_token,
            msg="SMTP not configured. Token logged for development.",
        )
        return True

    return await _send_smtp(to_email, subject, body_html)


async def send_verification_code_email(
    to_email: str, code: str, code_type: str
) -> bool:
    """Send a 6-digit verification code via email."""
    type_label = "ativacao de conta" if code_type == "activation" else "recuperacao de senha"
    subject = f"IconsAI - Codigo de {type_label}"
    body_html = f"""
    <html>
    <body style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Codigo de Verificacao</h2>
        <p>Seu codigo para {type_label}:</p>
        <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px;
                  background: #f0f0f0; padding: 16px; border-radius: 8px;
                  text-align: center;">
            {code}
        </p>
        <p><strong>Este codigo expira em 10 minutos.</strong></p>
        <p style="color: #666;">Se voce nao solicitou este codigo, ignore este email.</p>
        <hr>
        <p style="color: #666; font-size: 12px;">IconsAI - Inteligencia de Dados</p>
    </body>
    </html>
    """

    if not _is_smtp_configured():
        logger.info(
            "email_dev_mode",
            to=to_email,
            code=code,
            code_type=code_type,
            msg="SMTP not configured. Code logged for development.",
        )
        return True

    return await _send_smtp(to_email, subject, body_html)


async def send_password_reset_email(
    to_email: str, reset_token: str
) -> bool:
    """Send a password reset email with a token."""
    base_url = settings.app_base_url
    subject = "IconsAI - Recuperacao de Senha"
    body_html = f"""
    <html>
    <body style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Recuperacao de Senha</h2>
        <p>Voce solicitou a recuperacao de senha. Clique no botao abaixo:</p>
        <a href="{base_url}/reset-password?token={reset_token}"
           style="display: inline-block; background: #06b6d4; color: white; padding: 12px 24px;
                  border-radius: 8px; text-decoration: none; font-weight: bold;">
            Redefinir Senha
        </a>
        <p style="margin-top: 16px;"><strong>Este link expira em 1 hora.</strong></p>
        <p style="margin-top: 8px; color: #999; font-size: 11px;">
            Se o botao nao funcionar, copie e cole este link no navegador:<br>
            {base_url}/reset-password?token={reset_token}
        </p>
        <p style="color: #666;">Se voce nao solicitou, ignore este email.</p>
        <hr>
        <p style="color: #666; font-size: 12px;">IconsAI - Inteligencia de Dados</p>
    </body>
    </html>
    """

    if not _is_smtp_configured():
        logger.info(
            "email_dev_mode",
            to=to_email,
            reset_token=reset_token,
            msg="SMTP not configured. Token logged for development.",
        )
        return True

    return await _send_smtp(to_email, subject, body_html)
