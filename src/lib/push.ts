export type PushRuntimeConfig = {
  subject: string;
  publicKey: string;
  privateKey: string;
  adminToken: string | null;
};

export class PushConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushConfigurationError";
  }
}

function isVapidKey(value: string | undefined) {
  return Boolean(value && /^[A-Za-z0-9_-]+$/.test(value));
}

export function getPushRuntimeConfig(): PushRuntimeConfig {
  const subject = process.env.VAPID_SUBJECT?.trim();
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const adminToken = process.env.PUSH_ADMIN_TOKEN?.trim() || null;

  if (!subject || (!subject.startsWith("mailto:") && !subject.startsWith("https://"))) {
    throw new PushConfigurationError(
      "VAPID_SUBJECT 必须是 mailto: 邮箱或 https:// 地址。",
    );
  }
  if (!isVapidKey(publicKey) || !isVapidKey(privateKey)) {
    throw new PushConfigurationError("Railway 尚未配置有效的 VAPID 公钥和私钥。");
  }
  if (process.env.NODE_ENV === "production" && !adminToken) {
    throw new PushConfigurationError(
      "生产环境必须配置 PUSH_ADMIN_TOKEN，防止测试接口被公开滥用。",
    );
  }

  return {
    subject,
    publicKey: publicKey as string,
    privateKey: privateKey as string,
    adminToken,
  };
}
