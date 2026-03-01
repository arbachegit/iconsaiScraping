"""
Email service for sending verification and password reset emails.

Uses Resend API for sending.
In development mode (no RESEND_API_KEY configured), logs the code to console.
"""

import structlog

from config.settings import settings

logger = structlog.get_logger()


async def _send_resend(to_email: str, subject: str, body_html: str) -> bool:
    """Send an email via Resend API. Raises on failure."""
    import resend

    resend.api_key = settings.resend_api_key

    logger.info(
        "email_resend_attempt",
        to=to_email,
        subject=subject,
        email_from=settings.email_from,
    )

    try:
        params: resend.Emails.SendParams = {
            "from": f"IconsAI <{settings.email_from}>",
            "to": [to_email],
            "subject": subject,
            "html": body_html,
        }
        email_resp = resend.Emails.send(params)
        logger.info("email_sent", to=to_email, subject=subject, resend_id=email_resp.get("id"))
        return True
    except Exception as e:
        logger.error(
            "email_send_failed",
            to=to_email,
            subject=subject,
            error=str(e),
            error_type=type(e).__name__,
        )
        raise


def _is_email_configured() -> bool:
    """Check if Resend is properly configured."""
    return bool(settings.resend_api_key)


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

    if not _is_email_configured():
        logger.info(
            "email_dev_mode",
            to=to_email,
            subject=subject,
            set_password_token=set_password_token,
            msg="Resend not configured. Token logged for development.",
        )
        return True

    return await _send_resend(to_email, subject, body_html)


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

    if not _is_email_configured():
        logger.info(
            "email_dev_mode",
            to=to_email,
            code=code,
            code_type=code_type,
            msg="Resend not configured. Code logged for development.",
        )
        return True

    return await _send_resend(to_email, subject, body_html)


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

    if not _is_email_configured():
        logger.info(
            "email_dev_mode",
            to=to_email,
            reset_token=reset_token,
            msg="Resend not configured. Token logged for development.",
        )
        return True

    return await _send_resend(to_email, subject, body_html)
