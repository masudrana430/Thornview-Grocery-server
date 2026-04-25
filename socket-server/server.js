const express = require("express");
const http = require("http");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map(s => s.trim())
    : ["http://localhost:5173", "http://localhost:5174", "https://thornview-grocery.netlify.app"];

app.use(cors({ origin: allowedOrigins, credentials: true }));

// ---- Mongo ----
const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@thomview-dev.ahqcqe3.mongodb.net/?retryWrites=true&w=majority&appName=thomview-dev`;

const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: false, deprecationErrors: true },
});

let db, usersCollection, conversationsCollection, messagesCollection;
let dbInitPromise = null;

async function initDbOnce() {
    if (!dbInitPromise) {
        dbInitPromise = (async () => {
            await client.connect();
            db = client.db(process.env.DB_NAME || "thomview");
            usersCollection = db.collection("users");
            conversationsCollection = db.collection("chat_conversations");
            messagesCollection = db.collection("chat_messages");
            console.log("✅ Socket DB ready");
        })();
    }
    return dbInitPromise;
}

// ---- Socket.IO ----
const { Server } = require("socket.io");
const io = new Server(server, {
    cors: { origin: allowedOrigins, credentials: true },
});

app.get("/health", (_req, res) => res.json({ ok: true }));

io.use(async (socket, next) => {
    try {
        await initDbOnce();

        // ✅ token from client auth (works cross-domain)
        const token =
            socket.handshake.auth?.token ||
            (socket.handshake.headers.authorization?.startsWith("Bearer ")
                ? socket.handshake.headers.authorization.slice(7)
                : null);

        if (!token) return next(new Error("NO_TOKEN"));


        const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);

        const userId = String(payload.userId || "");
        if (!ObjectId.isValid(userId)) return next(new Error("BAD_USER_ID"));

        const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
        if (!user) return next(new Error("USER_NOT_FOUND"));

        socket.user = { userId, role: user.role || "customer" };
        next();
    } catch (e) {
        next(new Error("BAD_TOKEN"));
    }
});

io.on("connection", (socket) => {
    console.log("✅ socket connected:", socket.id, socket.user);

    const myId = String(socket.user.userId);
    const role = String(socket.user.role);

    // ✅ join role rooms
    if (["admin", "manager"].includes(role)) socket.join("admins");
    else socket.join("customers");

    // ✅ mark online
    setOnline(myId, role, socket.id);

    // ✅ admins should see customer online/offline
    io.to("admins").emit("presence:update", { userId: myId, online: true, role });

    // ✅ customers should see support online/offline
    const supportOnline = adminOnlineCount() > 0;
    // send to the just-connected socket
    socket.emit("support:presence", { online: supportOnline, admins: adminOnlineCount() });
    // broadcast to all customers if admin status might have changed
    io.to("customers").emit("support:presence", { online: supportOnline, admins: adminOnlineCount() });


    socket.on("conversation:join", async ({ conversationId }) => {
        try {
            const id = String(conversationId || "");
            if (!ObjectId.isValid(id)) return;

            if (!conversationsCollection) return;

            const conv = await conversationsCollection.findOne({ _id: new ObjectId(id) });
            if (!conv) return;

            const participants = (conv.participants || []).map(String);
            const isAdmin = ["admin", "manager"].includes(role);
            if (!isAdmin && !participants.includes(myId)) return;

            socket.join(`conv:${id}`);
            console.log("✅ joined room", `conv:${id}`, "by", myId);
        } catch (err) {
            console.error("conversation:join error:", err);
        }
    });

    socket.on("message:send", async (payload, ack) => {
        const safeAck = (obj) => {
            try {
                if (typeof ack === "function") ack(obj);
            } catch { }
        };

        try {
            if (!conversationsCollection || !messagesCollection) {
                return safeAck({ ok: false, error: "DB_NOT_READY" });
            }

            const conversationId = String(payload?.conversationId || "");
            const tempId = String(payload?.tempId || "");

            // ✅ FIX: text must exist
            const text = String(payload?.text ?? "").trim();

            // backwards compat (older clients send imageUrl only)
            const imageUrl = String(payload?.imageUrl ?? "").trim();
            const fileUrl = String(payload?.fileUrl ?? "").trim() || imageUrl;

            const fileName = String(payload?.fileName ?? "").trim();
            const mime = String(payload?.mime ?? "").trim();
            const size = Number.isFinite(Number(payload?.size)) ? Number(payload.size) : 0;
            const duration = Number.isFinite(Number(payload?.duration)) ? Number(payload.duration) : 0;

            // ✅ infer type if missing
            let type = String(payload?.type || "").trim().toLowerCase();
            if (!type) {
                if (!fileUrl) type = "text";
                else if (mime.startsWith("audio/")) type = "audio";
                else if (mime.startsWith("image/") || imageUrl) type = "image";
                else type = "file";
            }

            const allowedTypes = new Set(["text", "image", "file", "audio"]);
            if (!allowedTypes.has(type)) return safeAck({ ok: false, error: "BAD_TYPE", tempId });

            if (!ObjectId.isValid(conversationId)) {
                return safeAck({ ok: false, error: "BAD_CONVERSATION_ID", tempId });
            }

            // ✅ correct validation
            if (type === "text" && !text) {
                return safeAck({ ok: false, error: "EMPTY_TEXT", tempId });
            }
            if (type !== "text" && !fileUrl) {
                return safeAck({ ok: false, error: "MISSING_FILE_URL", tempId });
            }

            const conv = await conversationsCollection.findOne({ _id: new ObjectId(conversationId) });
            if (!conv) return safeAck({ ok: false, error: "CONVERSATION_NOT_FOUND", tempId });

            const participants = (conv.participants || []).map(String);
            const isAdmin = ["admin", "manager"].includes(String(role || ""));
            if (!isAdmin && !participants.includes(String(myId))) {
                return safeAck({ ok: false, error: "NOT_ALLOWED", tempId });
            }

            const now = new Date();

            // ✅ store unified fields (+ keep imageUrl for old UIs)
            const msg = {
                conversationId,
                senderId: String(myId),
                type,
                text: type === "text" ? text : "",
                fileUrl: type === "text" ? "" : fileUrl,
                imageUrl: type === "image" ? fileUrl : null, // backward compatibility
                fileName: type === "text" ? "" : fileName,
                mime: type === "text" ? "" : mime,
                size: type === "text" ? 0 : size,
                duration: type === "audio" ? duration : 0,
                createdAt: now,
            };

            const ins = await messagesCollection.insertOne(msg);
            msg._id = String(ins.insertedId);

            const preview =
                type === "image" ? "[image]" :
                    type === "audio" ? "[voice]" :
                        type === "file" ? "[file]" :
                            (text.slice(0, 120) || "");

            await conversationsCollection.updateOne(
                { _id: new ObjectId(conversationId) },
                {
                    $set: {
                        updatedAt: now,
                        lastMessageAt: now,
                        lastMessage: preview,
                    },
                }
            );

            // ✅ send to others in the room; sender updates via ACK
            socket.to(`conv:${conversationId}`).emit("message:new", { message: msg });

            return safeAck({ ok: true, message: msg, tempId });
        } catch (err) {
            console.error("message:send error:", err?.stack || err);
            return safeAck({ ok: false, error: "SERVER_ERROR", detail: String(err?.message || err) });
        }
    });


    socket.on("disconnect", () => {
        setOffline(myId, socket.id);

        // only broadcast offline if user fully disconnected (no more sockets)
        if (!isUserOnline(myId)) {
            io.to("admins").emit("presence:update", { userId: myId, online: false, role });
        }

        // support status may change if an admin disconnected
        if (["admin", "manager"].includes(role)) {
            io.to("customers").emit("support:presence", {
                online: adminOnlineCount() > 0,
                admins: adminOnlineCount(),
            });
        }
    });



});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`✅ Socket server listening on ${PORT}`));

// to run this file: node socket-server\server.js