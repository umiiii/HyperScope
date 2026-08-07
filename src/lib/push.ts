export type PushRuntimeConfig = {
  subject: string;
  publicKey: string;
  privateKey: string;
};

export class PushConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushConfigurationError";
  }
}

function isVapidKey(value: string | undefined, minimumLength: number) {
  return Boolean(
    value &&
      value.length >= minimumLength &&
      /^[A-Za-z0-9_-]+$/.test(value),
  );
}

export function getPushRuntimeConfig(): PushRuntimeConfig {
  const subject = process.env.VAPID_SUBJECT?.trim();
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();

  if (!subject || (!subject.startsWith("mailto:") && !subject.startsWith("https://"))) {
    throw new PushConfigurationError(
      "VAPID_SUBJECT 必须是 mailto: 邮箱或 https:// 地址。",
    );
  }
  if (!isVapidKey(publicKey, 80) || !isVapidKey(privateKey, 40)) {
    throw new PushConfigurationError("Railway 尚未配置有效的 VAPID 公钥和私钥。");
  }

  return {
    subject,
    publicKey: publicKey as string,
    privateKey: privateKey as string,
  };
}
