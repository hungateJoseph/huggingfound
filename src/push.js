// Notifications that reach a person with the site's tab closed: the
// browser's own push service (Web Push), which shows a system notification
// as long as the browser is running. The site's keys for it (VAPID) are made
// once and kept on its disk; a browser's subscription is kept with the
// account that asked, as base64url text, and used only to tell that account
// what became of its own watch.
import fs from "node:fs";
import path from "node:path";

export function createPush({ file = null, subject = "https://huggingfound.com", sendImpl = null } = {}) {
  let keys = null;
  let lib = null;
  const load = async () => {
    if (!lib && !sendImpl) {
      const mod = await import("web-push");
      lib = mod.default ?? mod;
    }
    if (keys) return keys;
    try {
      keys = file ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    } catch {
      keys = null;
    }
    if (!keys?.publicKey || !keys?.privateKey) {
      keys = sendImpl ? { publicKey: "test-public-key", privateKey: "test-private-key" } : lib.generateVAPIDKeys();
      if (file) {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
        } catch {
          // kept in memory for this run; a restart makes new ones and browsers subscribe again
        }
      }
    }
    return keys;
  };

  return {
    async publicKey() {
      return (await load()).publicKey;
    },
    // A browser's subscription as the page sends it, checked and packed for keeping.
    pack(subscription) {
      const s = subscription ?? {};
      if (typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint) || typeof s.keys?.p256dh !== "string" || typeof s.keys?.auth !== "string") return null;
      return Buffer.from(JSON.stringify({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } })).toString("base64url");
    },
    // Tells the browser behind a kept subscription; false when it could not.
    async send(packed, payload) {
      if (!packed) return false;
      let subscription;
      try {
        subscription = JSON.parse(Buffer.from(String(packed), "base64url").toString("utf8"));
      } catch {
        return false;
      }
      const k = await load();
      try {
        if (sendImpl) await sendImpl(subscription, payload);
        else await lib.sendNotification(subscription, JSON.stringify(payload), { vapidDetails: { subject, publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 6 * 3600 });
        return true;
      } catch {
        return false;
      }
    },
  };
}
