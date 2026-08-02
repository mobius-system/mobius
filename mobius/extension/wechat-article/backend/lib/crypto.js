// lib/crypto.js — AES-256-GCM 配置/凭据加密（config.enc / wx-token.enc）。
// 主密钥来源：MOBIUS_EXTENSION_SECRET 优先；否则用宿主 JWT_SECRET 派生（handler worker 可读宿主 env，
// 与 ai-hotspot-radar 读 RCC2_API_KEY 同理）。无密钥时生产模式拒绝落凭据（方案 §13）。

const crypto = require("crypto");

function rawKey() {
  const src = process.env.MOBIUS_EXTENSION_SECRET || process.env.JWT_SECRET || "";
  if (!src) return null;
  // 域隔离派生：拓展专用 32 字节密钥，与 JWT 签名用途隔离
  return crypto.createHash("sha256").update("wechat-article/v1:" + src).digest();
}
function hasKey() { return !!rawKey(); }

function encryptObj(obj) {
  const key = rawKey();
  if (!key) throw new Error("缺少主密钥（MOBIUS_EXTENSION_SECRET / JWT_SECRET），无法加密凭据");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const buf = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  const tag = c.getAuthTag();
  // 打包：ver(1) + iv(12) + tag(16) + ciphertext
  return Buffer.concat([Buffer.from([1]), iv, tag, buf]).toString("base64");
}

function decryptObj(str) {
  const key = rawKey();
  if (!key) throw new Error("缺少主密钥");
  const data = Buffer.from(String(str), "base64");
  if (data.length < 1 + 12 + 16) throw new Error("密文损坏");
  const ver = data[0], iv = data.slice(1, 13), tag = data.slice(13, 29), ct = data.slice(29);
  if (ver !== 1) throw new Error("密文版本不支持");
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  const json = Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  return JSON.parse(json);
}

module.exports = { hasKey, encryptObj, decryptObj };
