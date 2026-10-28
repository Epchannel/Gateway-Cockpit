import {
  argon2,
  argon2Sync,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export const apiKey = () => `hnq_${token()}`;
export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export const passwordHash = (password: string) => {
  const nonce = randomBytes(16);
  const key = argon2Sync("argon2id", {
    message: password,
    nonce,
    parallelism: 2,
    tagLength: 32,
    memory: 19456,
    passes: 2,
  });
  return `argon2id$${nonce.toString("base64url")}$${key.toString("base64url")}`;
};
const argon = (message: string, nonce: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    argon2(
      "argon2id",
      {
        message,
        nonce,
        parallelism: 2,
        tagLength: 32,
        memory: 19456,
        passes: 2,
      },
      (error, derived) =>
        error ? reject(error) : resolve(Buffer.from(derived)),
    ),
  );
export const passwordHashAsync = async (password: string) => {
  const nonce = randomBytes(16);
  return `argon2id$${nonce.toString("base64url")}$${(await argon(password, nonce)).toString("base64url")}`;
};
export const passwordVerify = (password: string, stored: string) => {
  const [v, nonce, key] = stored.split("$");
  if (v !== "argon2id" || !nonce || !key) return false;
  const actual = argon2Sync("argon2id", {
    message: password,
    nonce: Buffer.from(nonce, "base64url"),
    parallelism: 2,
    tagLength: 32,
    memory: 19456,
    passes: 2,
  }).toString("base64url");
  return safeEqual(actual, key);
};
export const passwordVerifyAsync = async (password: string, stored: string) => {
  const [version, nonce, key] = stored.split("$");
  if (version !== "argon2id" || !nonce || !key) return false;
  try {
    const actual = (
      await argon(password, Buffer.from(nonce, "base64url"))
    ).toString("base64url");
    return safeEqual(actual, key);
  } catch {
    return false;
  }
};
