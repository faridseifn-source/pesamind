const { Resend } = require("resend");
const { EmailProvider } = require("./EmailProvider");

class ResendEmailProvider extends EmailProvider {
  constructor({ apiKey, fromAddress }) {
    super();
    this.client = new Resend(apiKey);
    this.fromAddress = fromAddress;
  }

  async sendPasswordReset(toEmail, code) {
    const { error } = await this.client.emails.send({
      from: this.fromAddress,
      to: toEmail,
      subject: "Your PesaMind password reset code",
      html: `
        <div style="font-family: sans-serif; max-width: 420px; margin: 0 auto;">
          <p>Someone requested a password reset for your PesaMind account.</p>
          <p style="font-size: 28px; font-weight: 700; letter-spacing: 2px; background: #f3f2ee; padding: 16px; border-radius: 12px; text-align: center;">${code}</p>
          <p style="color: #666; font-size: 13px;">This code expires in 30 minutes. If you didn't request this, you can safely ignore this email — your password hasn't changed.</p>
        </div>
      `,
    });
    if (error) {
      // Surface the failure rather than silently swallowing it — a broken
      // email integration should be loud, not invisible.
      throw new Error(`Resend failed to send: ${error.message || JSON.stringify(error)}`);
    }
  }
}

module.exports = { ResendEmailProvider };
