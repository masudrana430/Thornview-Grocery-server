// chat/adminChatRouter.js
const express = require("express");
const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");

const adminChatRouter = express.Router();

// --- shared auth (uses same rules as your index.js requireAuth) ---
async function requireAuth(req, res, next) {
  try {
    const usersCollection = req.app.locals.usersCollection;

    const cookieToken = req.cookies?.accessToken;
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const token = cookieToken || bearerToken;

    if (!token) {
      return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing token" } });
    }

    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    if (!decoded?.userId) {
      return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Invalid token payload" } });
    }

    if (!usersCollection) {
      return res.status(503).json({ error: { code: "NOT_READY", message: "DB not ready yet" } });
    }

    const user = await usersCollection.findOne({ _id: new ObjectId(decoded.userId) });
    if (!user) {
      return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "User not found" } });
    }

    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Invalid/expired token" } });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role || !roles.includes(role)) {
      return res.status(403).json({ error: { code: "FORBIDDEN", message: `Requires role: ${roles.join(", ")}` } });
    }
    next();
  };
}

adminChatRouter.use(requireAuth);
adminChatRouter.use(requireRole("admin", "manager"));

// GET /api/admin/chat/conversations
adminChatRouter.get("/conversations", async (req, res) => {
  try {
    const conversationsCollection = req.app.locals.conversationsCollection;
    const usersCollection = req.app.locals.usersCollection;

    if (!conversationsCollection || !usersCollection) {
      return res.status(503).json({ error: { code: "NOT_READY", message: "DB not ready yet" } });
    }

    const items = await conversationsCollection
      .find({})
      .sort({ updatedAt: -1, lastMessageAt: -1, createdAt: -1 })
      .limit(200)
      .toArray();

    // attach "otherUser" based on participants[?] (simple: pick first non-admin if possible)
    const results = [];
    for (const c of items) {
      const participants = (c.participants || []).map(String);

      // find a participant that is NOT the admin viewing (best effort)
      const otherId = participants.find((p) => p !== String(req.user._id)) || participants[0] || null;

      let otherUser = null;
      if (otherId && ObjectId.isValid(otherId)) {
        const u = await usersCollection.findOne(
          { _id: new ObjectId(otherId) },
          { projection: { name: 1, email: 1, avatar: 1, role: 1 } }
        );
        if (u) otherUser = { _id: String(u._id), ...u };
      }

      results.push({
        ...c,
        _id: String(c._id),
        otherUser,
        unread: Number(c.unread || 0),
      });
    }

    res.json({ data: { conversations: results } });
  } catch (err) {
    console.error("GET /admin/chat/conversations error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load conversations" } });
  }
});

// GET /api/admin/chat/messages/:conversationId
adminChatRouter.get("/messages/:conversationId", async (req, res) => {
  try {
    const messagesCollection = req.app.locals.messagesCollection;
    const conversationsCollection = req.app.locals.conversationsCollection;

    if (!messagesCollection || !conversationsCollection) {
      return res.status(503).json({ error: { code: "NOT_READY", message: "DB not ready yet" } });
    }

    const id = String(req.params.conversationId || "");
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid conversation id" } });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit || "80", 10), 1), 200);

    const conv = await conversationsCollection.findOne({ _id: new ObjectId(id) });
    if (!conv) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Conversation not found" } });

    const msgs = await messagesCollection
      .find({ conversationId: String(id) })
      .sort({ createdAt: 1 })
      .limit(limit)
      .toArray();

    res.json({
      data: {
        messages: msgs.map((m) => ({ ...m, _id: String(m._id) })),
      },
    });
  } catch (err) {
    console.error("GET /admin/chat/messages/:id error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load messages" } });
  }
});

module.exports = { adminChatRouter };
