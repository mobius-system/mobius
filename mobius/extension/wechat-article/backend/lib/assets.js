const path = require("path");

function safeUserSegment(username) {
  return String(username || "unknown").replace(/[^A-Za-z0-9_.@-]/g, "_").slice(0, 120) || "unknown";
}

function safeSegment(value, fallback = "item", max = 80) {
  const cleaned = String(value || "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, max);
  return cleaned || fallback;
}

function userRoot(extDataDir, username) {
  return path.join(extDataDir, "users", safeUserSegment(username));
}

function articleRoot(extDataDir, username, articleId) {
  return path.join(userRoot(extDataDir, username), "articles", safeSegment(articleId, "article", 120));
}

function relativeToUser(extDataDir, username, absolutePath) {
  const root = path.resolve(userRoot(extDataDir, username));
  const absolute = path.resolve(absolutePath);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return "";
  return path.relative(root, absolute).split(path.sep).join("/");
}

module.exports = { safeUserSegment, safeSegment, userRoot, articleRoot, relativeToUser };
