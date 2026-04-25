// index.js (server) — Thomview Grocery
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
require("dotenv").config();
// const Stripe = require("stripe");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
// const STRIPE_CURRENCY = (process.env.STRIPE_CURRENCY || "bdt").toLowerCase();

const http = require("http");
const { Server } = require("socket.io");

// Vercel detection
const isVercel = !!process.env.VERCEL;


const cookie = require("cookie");


// const serviceAccount = require("./sarviceKey.json");
// const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
// const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
//   ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
//   : require("./sarviceKey.json");


// ? befor deploy 
// let serviceAccount;

// if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
//   serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

//   if (serviceAccount.private_key) {
//     serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
//   }
// } else {
//   serviceAccount = require("./sarviceKey.json"); // local fallback
// }
//?or
// const serviceAccount = require("./sarviceKey.json");

//? for deploy
// const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
// const serviceAccount = JSON.parse(decoded);
// or
let serviceAccount;

if (process.env.FB_SERVICE_KEY) {
  // FB_SERVICE_KEY should be base64 of the whole JSON file
  const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString("utf8");
  serviceAccount = JSON.parse(decoded);
} else {
  // local dev fallback (only if the file exists locally)
  serviceAccount = require("./sarviceKey.json");
}

//? befor deploy 
// socket.io:
//const cookies = parseCookies(socket.handshake.headers?.cookie || "");
      // const token = cookies.accessToken;
//comment it

// all console.log commented for deploy
// await client.connect() commented for deploy
// after deploying , uncomment it =====>>>> search it . and uncomment the console .log



// for socket auth
const { uploadRouter } = require("./chat/uploadRouter");
const { adminChatRouter } = require("./chat/adminChatRouter");

const app = express();
const port = process.env.PORT || 5000;
const isProd = process.env.NODE_ENV === "production";

const multer = require("multer");
const { customerUploadRouter } = require("./chat/customerUploadRouter");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});


// ------------------- Required ENV checks -------------------
const requiredEnv = ["DB_USERNAME", "DB_PASSWORD", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"];
for (const k of requiredEnv) {
  if (!process.env[k]) {
  throw new Error(`Missing env: ${k}`);
}

}
// Fix middleware order: trust proxy should be before cookies/routes
// after adding app.set it fixed deploy in railway
app.set("trust proxy", 1);

// ------------------- Middleware -------------------
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim())
  : ["http://localhost:5173", "http://localhost:5174", "https://thomview-grocery.web.app" ,  "https://thomview-grocery.firebaseapp.com",];



app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow non-browser tools
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`), false);
  },
  credentials: true,
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"],
}));

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

app.use("/api/admin/chat", adminChatRouter);
app.use("/api/admin/uploads", uploadRouter);





// ------------------- Firebase Admin Init -------------------
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
  });
}
// console.log("✅ Firebase Admin project_id:", serviceAccount.project_id);
// after deploy uncomment it

// ------------------- MongoDB -------------------
const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@thomview-dev.ahqcqe3.mongodb.net/?retryWrites=true&w=majority&appName=thomview-dev`;

// IMPORTANT: strict:false avoids API Strict limitation on creating text index in some setups
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: false,
    deprecationErrors: true,
  },
});

// ------------------- Global Variables -------------------
let usersCollection;
let homeMosaicsCollection;
let productsCollection;
let db; // ✅ add this (global)
let ordersCollection; // ✅ add this (global)
let homeBrandBannersCollection;
let homeBigDealsCollection;
let homeProductRailsCollection;
let homeHeroWithRailCollection;
let homeRailWithBannerCollection;
let homeDepartmentsCollection;
let homeRailSectionsCollection;



// search capability flag
let supportsTextSearch = false;

//helpers for order flow
const ORDER_FLOW = {
  delivery: ["pending_payment", "placed", "confirmed", "packed", "out_for_delivery", "delivered"],
  pickup: ["pending_payment", "placed", "confirmed", "ready_for_pickup", "picked_up"],
};

function buildOwner(user) {
  return {
    userId: String(user?._id || ""),              // ObjectId -> string
    firebaseUid: String(user?.firebaseUid || ""),
    email: String(user?.email || ""),
  };
}

function isOrderOwner(order, user) {
  const uid = String(user?._id || "");
  const fuid = String(user?.firebaseUid || "");
  // Support old + new schemas
  return (
    String(order?.owner?.userId || "") === uid ||
    String(order?.userId || "") === uid ||
    (fuid && String(order?.owner?.firebaseUid || "") === fuid) ||
    (fuid && String(order?.firebaseUid || "") === fuid)
  );
}

function timelineEntry({ status, note = "", byUser }) {
  return {
    status: String(status),
    note: String(note || ""),
    at: new Date(),
    by: byUser
      ? { userId: String(byUser._id), email: byUser.email || "", role: byUser.role || "" }
      : null,
  };
}


//helper for order status
const ORDER_STATUSES = new Set([
  "pending_payment",
  "placed",
  "confirmed",
  "processing",
  "packed",
  "shipped",
  "out_for_delivery",
  "delivered",
  "cancelled",
]);


//helper for pyment
function generateOrderNumber() {
  // Example: TV-20260125-K9F3A2
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `TV-${ymd}-${rand}`;
}

function normalizeQty(qty) {
  const n = parseInt(qty, 10);
  if (Number.isNaN(n) || n < 1) return 1;
  return Math.min(n, 20);
}

async function buildCheckoutFromItems({ items, mode }) {
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error("Cart items are required");
    err.status = 400;
    throw err;
  }

  // Expect: [{ productId, qty }]
  const normalized = items.map((i) => ({
    productId: String(i.productId || "").trim(),
    qty: normalizeQty(i.qty),
  }));

  // Validate ObjectIds
  const ids = [...new Set(normalized.map((i) => i.productId))];
  for (const id of ids) {
    if (!ObjectId.isValid(id)) {
      const err = new Error(`Invalid productId: ${id}`);
      err.status = 400;
      throw err;
    }
  }

  const objIds = ids.map((id) => new ObjectId(id));

  const products = await productsCollection
    .find(
      { _id: { $in: objIds }, isActive: { $ne: false } },
      { projection: { name: 1, slug: 1, price: 1, oldPrice: 1, image: 1, images: 1, inStock: 1 } }
    )
    .toArray();

  const map = new Map(products.map((p) => [p._id.toString(), p]));

  let subtotal = 0;
  const snapshotItems = [];

  for (const line of normalized) {
    const p = map.get(line.productId);
    if (!p) {
      const err = new Error(`Product not found: ${line.productId}`);
      err.status = 400;
      throw err;
    }

    if (p.inStock === false) {
      const err = new Error(`Out of stock: ${p.name}`);
      err.status = 400;
      throw err;
    }

    const priceNum = Number(p.price || 0);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      const err = new Error(`Invalid price for: ${p.name}`);
      err.status = 400;
      throw err;
    }

    subtotal += priceNum * line.qty;

    snapshotItems.push({
      productId: p._id.toString(),
      name: p.name,
      slug: p.slug || "",
      image: (Array.isArray(p.images) && p.images[0]) || p.image || "",
      price: priceNum,
      oldPrice: p.oldPrice || null,
      qty: line.qty,
      inStock: p.inStock !== false,
    });
  }

  const deliveryFee = mode === "delivery" ? (subtotal >= 2000 ? 0 : 60) : 0;
  const total = subtotal + deliveryFee;

  return { items: snapshotItems, subtotal, deliveryFee, total };
}


//helpers for order ownership

function normalizeId(v) {
  if (!v) return null;
  // ObjectId
  if (typeof v === "object" && v.toString) return String(v.toString());
  // string
  return String(v);
}

function isOrderOwner(order, user) {
  const meMongoId = normalizeId(user?._id);
  const meEmail = String(user?.email || "").toLowerCase();
  const meFirebaseUid = String(user?.firebaseUid || "");

  const orderUserId = normalizeId(order?.userId);
  const orderEmail =
    String(order?.email || order?.userEmail || order?.user?.email || "").toLowerCase();
  const orderFirebaseUid =
    String(order?.firebaseUid || order?.user?.firebaseUid || "");

  // Accept if ANY owner identifier matches
  if (orderUserId && meMongoId && orderUserId === meMongoId) return true;
  if (orderUserId && meFirebaseUid && orderUserId === meFirebaseUid) return true; // in case userId stored firebase uid
  if (orderFirebaseUid && meFirebaseUid && orderFirebaseUid === meFirebaseUid) return true;
  if (orderEmail && meEmail && orderEmail === meEmail) return true;

  return false;
}


// helper for checkout session
function toObjectId(id) {
  if (!ObjectId.isValid(id)) return null;
  return new ObjectId(id);
}

function computeDeliveryFee(mode, subtotal) {
  if (mode !== "delivery") return 0;
  return subtotal >= 2000 ? 0 : 60;
}

async function buildPricedItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error("Cart items are required");
    err.code = "BAD_REQUEST";
    throw err;
  }

  // normalize {productId, qty}
  const normalized = items
    .filter((it) => it && it.productId)
    .map((it) => ({
      productId: String(it.productId),
      qty: Math.max(1, Math.min(99, Number(it.qty || 1))),
    }));

  if (!normalized.length) {
    const err = new Error("Cart items are required");
    err.code = "BAD_REQUEST";
    throw err;
  }

  const ids = normalized.map((it) => toObjectId(it.productId)).filter(Boolean);
  if (ids.length !== normalized.length) {
    const err = new Error("Invalid productId in cart");
    err.code = "BAD_REQUEST";
    throw err;
  }

  const products = await productsCollection
    .find({ _id: { $in: ids }, isActive: { $ne: false } })
    .project({ name: 1, price: 1, image: 1, images: 1, slug: 1, inStock: 1 })
    .toArray();

  const map = new Map(products.map((p) => [String(p._id), p]));

  const priced = normalized.map((it) => {
    const p = map.get(it.productId);
    if (!p) {
      const err = new Error(`Product not found: ${it.productId}`);
      err.code = "NOT_FOUND";
      throw err;
    }

    const priceNum = Number(p.price);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      const err = new Error(`Invalid price for product: ${it.productId}`);
      err.code = "SERVER_ERROR";
      throw err;
    }

    return {
      productId: String(p._id),
      name: p.name || "Product",
      slug: p.slug || "",
      image: p.image || (Array.isArray(p.images) ? p.images[0] : ""),
      price: priceNum,
      qty: it.qty,
      inStock: p.inStock !== false,
    };
  });

  const subtotal = priced.reduce((sum, it) => sum + it.price * it.qty, 0);

  return { priced, subtotal };
}


// ------------------- Helpers -------------------
function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function signAccessToken(payload) {
  return jwt.sign(payload, process.env.JWT_ACCESS_SECRET, {
    expiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || "30m",
  });
}

function signRefreshToken(payload) {
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || "14d",
  });
}

function setAuthCookies(res, accessToken, refreshToken) {
  const base = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/"
  };

  res.cookie("accessToken", accessToken, { ...base, maxAge: 1000 * 60 * 60 }); // 1h
  res.cookie("refreshToken", refreshToken, { ...base, maxAge: 1000 * 60 * 60 * 24 * 14 }); // 14d
}

function clearAuthCookies(res) {
  const base = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
  };
  res.clearCookie("accessToken", base);
  res.clearCookie("refreshToken", base);
}

function escapeRegex(str = "") {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function safeCreateIndex(collection, keys, options) {
  try {
    await collection.createIndex(keys, options);
  } catch (e) {
    console.warn("⚠️ createIndex skipped:", e?.message || e);
  }
}

// ------------------- Auth Middleware -------------------
async function requireAuth(req, res, next) {
  try {
    const cookieToken = req.cookies?.accessToken;
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const token = cookieToken || bearerToken;

    if (!token) {
      return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing token" } });
    }

    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    const user = await usersCollection.findOne({ _id: new ObjectId(decoded.userId) });

    if (!user) {
      return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "User not found" } });
    }
    if (user.status && user.status !== "active") {
      return res.status(403).json({ error: { code: "FORBIDDEN", message: "User disabled" } });
    }

    req.user = user;
    next();
  } catch (_err) {
    return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Invalid/expired token" } });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role || !roles.includes(role)) {
      return res.status(403).json({
        error: { code: "FORBIDDEN", message: `Requires role: ${roles.join(", ")}` },
      });
    }
    next();
  };
}

// userId -> { role, sockets:Set(socketId) }
// userId -> { role, sockets:Set<string> }
const online = new Map();

function setOnline(userId, role, socketId) {
  const key = String(userId);
  if (!online.has(key)) online.set(key, { role: String(role || ""), sockets: new Set() });
  const entry = online.get(key);
  entry.role = String(role || entry.role || "");
  entry.sockets.add(socketId);
}

function setOffline(userId, socketId) {
  const key = String(userId);
  const entry = online.get(key);
  if (!entry) return;
  entry.sockets.delete(socketId);
  if (entry.sockets.size === 0) online.delete(key);
}

function isUserOnline(userId) {
  return online.has(String(userId));
}

function adminOnlineCount() {
  let n = 0;
  for (const [, entry] of online) {
    if (["admin", "manager"].includes(entry.role) && entry.sockets.size > 0) n++;
  }
  return n;
}




// ------------------- Routes -------------------
// Health Check after deployments
app.get("/", (_req, res) => {
  res.type("text").send("Thomview Grocery API is running ✅");
});
app.get("/health", (_req, res) => res.json({ ok: true }));
// Basic root route(for testing)



/**
 * POST /api/auth/login
 * Body: { firebaseIdToken }
 */
app.post("/api/auth/login", async (req, res) => {
  try {
    const { firebaseIdToken } = req.body || {};
    if (!firebaseIdToken || typeof firebaseIdToken !== "string") {
      return res.status(400).json({
        error: { code: "BAD_REQUEST", message: "firebaseIdToken is required (string)" },
      });
    }

    const decoded = await admin.auth().verifyIdToken(firebaseIdToken);

    // optional audience check (good for debugging mismatched Firebase projects)
    if (decoded.aud !== serviceAccount.project_id) {
      return res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: `Token audience mismatch. aud=${decoded.aud} expected=${serviceAccount.project_id}`,
        },
      });
    }

    const firebaseUid = decoded.uid;
    const email = decoded.email || "";
    const name = decoded.name || decoded.displayName || "";
    const avatar = decoded.picture || "";

    if (!email) {
      return res.status(400).json({
        error: { code: "BAD_REQUEST", message: "Firebase token has no email" },
      });
    }

    const now = new Date();
    const existing = await usersCollection.findOne({ firebaseUid });

    let userDoc;

    if (!existing) {
      // if email already exists, link it instead of crashing unique index
      const byEmail = await usersCollection.findOne({ email });
      if (byEmail) {
        await usersCollection.updateOne(
          { _id: byEmail._id },
          {
            $set: {
              firebaseUid,
              ...(name ? { name } : {}),
              ...(avatar ? { avatar } : {}),
              lastLoginAt: now,
              updatedAt: now,
            },
          }
        );
        userDoc = await usersCollection.findOne({ _id: byEmail._id });
      } else {
        userDoc = {
          firebaseUid,
          email,
          name,
          avatar,
          role: "customer",
          status: "active",
          phone: "",
          addresses: [],
          marketingOptIn: false,
          marketingOptInAt: null,
          discountRate: 0,
          createdAt: now,
          updatedAt: now,
          lastLoginAt: now,
          refreshTokenHash: null,
        };
        const ins = await usersCollection.insertOne(userDoc);
        userDoc._id = ins.insertedId;
      }
    } else {
      await usersCollection.updateOne(
        { _id: existing._id },
        {
          $set: {
            email,
            ...(name ? { name } : {}),
            ...(avatar ? { avatar } : {}),
            lastLoginAt: now,
            updatedAt: now,
          },
        }
      );
      userDoc = await usersCollection.findOne({ _id: existing._id });
    }

    const accessToken = signAccessToken({ userId: userDoc._id.toString(), role: userDoc.role });
    const refreshToken = signRefreshToken({ userId: userDoc._id.toString() });

    await usersCollection.updateOne(
      { _id: userDoc._id },
      { $set: { refreshTokenHash: sha256(refreshToken) } }
    );

    setAuthCookies(res, accessToken, refreshToken);

    return res.json({
      data: {
        user: {
          id: userDoc._id,
          email: userDoc.email,
          name: userDoc.name,
          role: userDoc.role,
          avatar: userDoc.avatar || "",
          marketingOptIn: !!userDoc.marketingOptIn,
        },
        accessToken,
      },
    });
  } catch (err) {
    console.error("verifyIdToken failed:", err);
    return res.status(401).json({
      error: { code: "UNAUTHORIZED", message: err?.message || "verifyIdToken failed" },
    });
  }
});

app.post("/api/auth/refresh", async (req, res) => {
  try {
    const token = req.cookies?.refreshToken;
    if (!token) {
      return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing refresh token" } });
    }

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const user = await usersCollection.findOne({ _id: new ObjectId(decoded.userId) });

    if (!user) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "User not found" } });
    if (!user.refreshTokenHash || user.refreshTokenHash !== sha256(token)) {
      return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Refresh token revoked" } });
    }

    const newAccessToken = signAccessToken({ userId: user._id.toString(), role: user.role });

    res.cookie("accessToken", newAccessToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? "none" : "lax",
      maxAge: 1000 * 60 * 60,
    });

    return res.json({ data: { accessToken: newAccessToken } });
  } catch {
    return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Invalid refresh token" } });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = req.cookies?.refreshToken;
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
        await usersCollection.updateOne(
          { _id: new ObjectId(decoded.userId) },
          { $set: { refreshTokenHash: null } }
        );
      } catch (_) { }
    }

    clearAuthCookies(res);
    return res.json({ data: { ok: true } });
  } catch {
    clearAuthCookies(res);
    return res.json({ data: { ok: true } });
  }
});

app.get("/api/users/me", requireAuth, async (req, res) => {
  const u = req.user;
  res.json({
    data: {
      user: {
        id: u._id,
        email: u.email,
        name: u.name || "",
        role: u.role,
        avatar: u.avatar || "",
        phone: u.phone || "",
        marketingOptIn: !!u.marketingOptIn,
      },
    },
  });
});

app.patch("/api/users/me", requireAuth, async (req, res) => {
  const { name, phone, marketingOptIn, avatar } = req.body || {};
  const now = new Date();

  const update = { updatedAt: now };
  if (typeof name === "string") update.name = name.trim();
  if (typeof phone === "string") update.phone = phone.trim();
  if (typeof avatar === "string") update.avatar = avatar.trim();
  if (typeof marketingOptIn === "boolean") {
    update.marketingOptIn = marketingOptIn;
    update.marketingOptInAt = marketingOptIn ? now : null;
  }

  await usersCollection.updateOne({ _id: new ObjectId(req.user._id) }, { $set: update });
  const refreshed = await usersCollection.findOne({ _id: new ObjectId(req.user._id) });

  res.json({
    data: {
      user: {
        id: refreshed._id,
        email: refreshed.email,
        name: refreshed.name || "",
        role: refreshed.role,
        avatar: refreshed.avatar || "",
        phone: refreshed.phone || "",
        marketingOptIn: !!refreshed.marketingOptIn,
      },
    },
  });
});

// ------------------- HOMEPAGE MOSAIC (Dynamic) -------------------
function toMosaicResponse(doc) {
  // supports:
  // 1) { slug, enabled, mosaic:{...}, heroSlides:[...] }
  // 2) { slug, enabled, leftTop..., heroSlides... } (legacy)
  if (!doc) return null;
  const base = doc.mosaic && typeof doc.mosaic === "object" ? { ...doc.mosaic } : { ...doc };

  const heroSlides = Array.isArray(doc.heroSlides)
    ? doc.heroSlides
    : Array.isArray(base.heroSlides)
      ? base.heroSlides
      : [];

  return { ...base, heroSlides };
}

/**
 * Public: GET /api/home/mosaic?slug=home
 * Returns: { data: { mosaic: {...} } }
 */
app.get("/api/home/mosaic", async (req, res) => {
  try {
    const slug = String(req.query.slug || "home").toLowerCase();
    const doc = await homeMosaicsCollection.findOne({ slug });

    if (!doc || doc.enabled === false) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "Homepage mosaic not configured yet" },
      });
    }

    return res.json({ data: { mosaic: toMosaicResponse(doc) } });
  } catch (err) {
    console.error("GET /api/home/mosaic error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to load homepage mosaic" },
    });
  }
});

/**
 * Admin: GET /api/admin/home/mosaic?slug=home
 */
app.get("/api/admin/home/mosaic", requireAuth, requireRole("admin", "marketing"), async (req, res) => {
  try {
    const slug = String(req.query.slug || "home").toLowerCase();
    const doc = await homeMosaicsCollection.findOne({ slug });

    if (!doc) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "Homepage mosaic not configured yet" },
      });
    }

    return res.json({ data: doc });
  } catch (err) {
    console.error("GET /api/admin/home/mosaic error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to load admin mosaic" },
    });
  }
});

/**
 * Admin: PUT /api/admin/home/mosaic?slug=home
 * Body: { enabled?:boolean, mosaic?:object, heroSlides?:array }
 */
app.put("/api/admin/home/mosaic", requireAuth, requireRole("admin", "marketing"), async (req, res) => {
  try {
    const slug = String(req.query.slug || "home").toLowerCase();
    const body = req.body || {};

    const incomingMosaic =
      body.mosaic && typeof body.mosaic === "object"
        ? body.mosaic
        : { ...body, mosaic: undefined, enabled: undefined };

    if (!incomingMosaic || typeof incomingMosaic !== "object") {
      return res.status(400).json({
        error: { code: "BAD_REQUEST", message: "mosaic data is required" },
      });
    }

    const now = new Date();

    const updateDoc = {
      slug,
      enabled: typeof body.enabled === "boolean" ? body.enabled : true,
      mosaic: incomingMosaic,
      heroSlides: Array.isArray(body.heroSlides)
        ? body.heroSlides
        : Array.isArray(incomingMosaic.heroSlides)
          ? incomingMosaic.heroSlides
          : [],
      updatedAt: now,
    };

    const result = await homeMosaicsCollection.findOneAndUpdate(
      { slug },
      { $set: updateDoc, $setOnInsert: { createdAt: now } },
      { upsert: true, returnDocument: "after" }
    );

    return res.json({ data: result.value });
  } catch (err) {
    console.error("PUT /api/admin/home/mosaic error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to save homepage mosaic" },
    });
  }
});


// ------------------- HOMEPAGE BRAND BANNERS (Dynamic) -------------------
function toBrandBannersResponse(doc) {
  // supports:
  // 1) { slug, enabled, items:[...] }
  // 2) legacy: { slug, enabled, brandBanners:[...] }
  if (!doc) return null;

  const items = Array.isArray(doc.items)
    ? doc.items
    : Array.isArray(doc.brandBanners)
      ? doc.brandBanners
      : [];

  return { items };
}

/**
 * Public: GET /api/home/brand-banners?slug=home
 * Returns: { data: { items: [...] } }
 */
app.get("/api/home/brand-banners", async (req, res) => {
  try {
    const slug = String(req.query.slug || "home").toLowerCase();
    const doc = await homeBrandBannersCollection.findOne({ slug });

    if (!doc || doc.enabled === false) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "Brand banners not configured yet" },
      });
    }

    return res.json({ data: toBrandBannersResponse(doc) });
  } catch (err) {
    console.error("GET /api/home/brand-banners error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to load brand banners" },
    });
  }
});

/**
 * Admin: GET /api/admin/home/brand-banners?slug=home
 */
app.get(
  "/api/admin/home/brand-banners",
  requireAuth,
  requireRole("admin", "marketing"),
  async (req, res) => {
    try {
      const slug = String(req.query.slug || "home").toLowerCase();
      const doc = await homeBrandBannersCollection.findOne({ slug });

      if (!doc) {
        return res.status(404).json({
          error: { code: "NOT_FOUND", message: "Brand banners not configured yet" },
        });
      }

      return res.json({ data: doc });
    } catch (err) {
      console.error("GET /api/admin/home/brand-banners error:", err);
      return res.status(500).json({
        error: { code: "SERVER_ERROR", message: "Failed to load admin brand banners" },
      });
    }
  }
);

/**
 * Admin: PUT /api/admin/home/brand-banners?slug=home
 * Body: { enabled?: boolean, items: array }
 */
app.put(
  "/api/admin/home/brand-banners",
  requireAuth,
  requireRole("admin", "marketing"),
  async (req, res) => {
    try {
      const slug = String(req.query.slug || "home").toLowerCase();
      const body = req.body || {};

      if (!Array.isArray(body.items)) {
        return res.status(400).json({
          error: { code: "BAD_REQUEST", message: "items array is required" },
        });
      }

      // keep DB clean + UI stable
      const items = body.items
        .map((x = {}) => ({
          id: String(x.id || x._id || crypto.randomBytes(8).toString("hex")),
          title: String(x.title || ""),
          subtitle: String(x.subtitle || ""),
          href: String(x.href || "/shop"),
          image: String(x.image || ""),
          sponsored: Boolean(x.sponsored),
        }))
        .filter((x) => x.title || x.image);

      const now = new Date();

      const updateDoc = {
        slug,
        enabled: typeof body.enabled === "boolean" ? body.enabled : true,
        items,
        updatedAt: now,
      };

      const result = await homeBrandBannersCollection.findOneAndUpdate(
        { slug },
        { $set: updateDoc, $setOnInsert: { createdAt: now } },
        { upsert: true, returnDocument: "after" }
      );

      return res.json({ data: result.value });
    } catch (err) {
      console.error("PUT /api/admin/home/brand-banners error:", err);
      return res.status(500).json({
        error: { code: "SERVER_ERROR", message: "Failed to save brand banners" },
      });
    }
  }
);


// ------------------- HOMEPAGE BIG DEALS (Dynamic) -------------------
function toBigDealsResponse(doc) {
  // supports:
  // 1) { slug, enabled, items:[...] }
  // 2) legacy: { slug, enabled, bigDeals:[...] }
  if (!doc) return null;

  const items = Array.isArray(doc.items)
    ? doc.items
    : Array.isArray(doc.bigDeals)
      ? doc.bigDeals
      : [];

  return { items };
}

/**
 * Public: GET /api/home/big-deals?slug=home
 * Returns: { data: { items: [...] } }
 */
app.get("/api/home/big-deals", async (req, res) => {
  try {
    const slug = String(req.query.slug || "home").toLowerCase();
    const doc = await homeBigDealsCollection.findOne({ slug });

    if (!doc || doc.enabled === false) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "Big deals not configured yet" },
      });
    }

    return res.json({ data: toBigDealsResponse(doc) });
  } catch (err) {
    console.error("GET /api/home/big-deals error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to load big deals" },
    });
  }
});

/**
 * Admin: GET /api/admin/home/big-deals?slug=home
 */
app.get(
  "/api/admin/home/big-deals",
  requireAuth,
  requireRole("admin", "marketing"),
  async (req, res) => {
    try {
      const slug = String(req.query.slug || "home").toLowerCase();
      const doc = await homeBigDealsCollection.findOne({ slug });

      if (!doc) {
        return res.status(404).json({
          error: { code: "NOT_FOUND", message: "Big deals not configured yet" },
        });
      }

      return res.json({ data: doc });
    } catch (err) {
      console.error("GET /api/admin/home/big-deals error:", err);
      return res.status(500).json({
        error: { code: "SERVER_ERROR", message: "Failed to load admin big deals" },
      });
    }
  }
);

/**
 * Admin: PUT /api/admin/home/big-deals?slug=home
 * Body: { enabled?: boolean, items: array }
 */
app.put(
  "/api/admin/home/big-deals",
  requireAuth,
  requireRole("admin", "marketing"),
  async (req, res) => {
    try {
      const slug = String(req.query.slug || "home").toLowerCase();
      const body = req.body || {};

      if (!Array.isArray(body.items)) {
        return res.status(400).json({
          error: { code: "BAD_REQUEST", message: "items array is required" },
        });
      }

      const items = body.items
        .map((x = {}) => ({
          id: String(x.id || x._id || crypto.randomBytes(8).toString("hex")),
          title: String(x.title || ""),
          subtitle: String(x.subtitle || ""),
          href: String(x.href || "/shop?deals=1"),
          image: String(x.image || ""),
          theme: String(x.theme || "light"),     // "red" | "green" | "yellow" | "blue" | "light"
          priceTag: x.priceTag ? String(x.priceTag) : "",
          span: String(x.span || "col-span-12 md:col-span-6 row-span-1"),
          sponsored: Boolean(x.sponsored),
          badge: x.badge ? String(x.badge) : "",
        }))
        .filter((x) => x.title || x.image);

      const now = new Date();

      const updateDoc = {
        slug,
        enabled: typeof body.enabled === "boolean" ? body.enabled : true,
        items,
        updatedAt: now,
      };

      const result = await homeBigDealsCollection.findOneAndUpdate(
        { slug },
        { $set: updateDoc, $setOnInsert: { createdAt: now } },
        { upsert: true, returnDocument: "after" }
      );

      return res.json({ data: result.value });
    } catch (err) {
      console.error("PUT /api/admin/home/big-deals error:", err);
      return res.status(500).json({
        error: { code: "SERVER_ERROR", message: "Failed to save big deals" },
      });
    }
  }
);


// ------------------- HOMEPAGE PRODUCT RAILS (Dynamic) -------------------
function toProductRailResponse(doc) {
  // supports:
  // 1) { slug, enabled, title, viewAllHref, items:[...] }
  // 2) legacy: { slug, enabled, rail:{...} }
  if (!doc) return null;

  const rail = doc.rail && typeof doc.rail === "object" ? doc.rail : doc;

  return {
    title: String(rail.title || ""),
    viewAllHref: rail.viewAllHref ? String(rail.viewAllHref) : "",
    items: Array.isArray(rail.items) ? rail.items : [],
  };
}

/**
 * Public: GET /api/home/product-rail?slug=home&key=baby-musts
 * You can keep multiple rails by changing "key".
 * Returns: { data: { title, viewAllHref, items:[...] } }
 */
app.get("/api/home/product-rail", async (req, res) => {
  try {
    const slug = String(req.query.slug || "home").toLowerCase();
    const key = String(req.query.key || "default").toLowerCase();

    const doc = await homeProductRailsCollection.findOne({ slug, key });

    if (!doc || doc.enabled === false) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "Product rail not configured yet" },
      });
    }

    return res.json({ data: toProductRailResponse(doc) });
  } catch (err) {
    console.error("GET /api/home/product-rail error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to load product rail" },
    });
  }
});

/**
 * Admin: GET /api/admin/home/product-rail?slug=home&key=baby-musts
 */
app.get(
  "/api/admin/home/product-rail",
  requireAuth,
  requireRole("admin", "marketing"),
  async (req, res) => {
    try {
      const slug = String(req.query.slug || "home").toLowerCase();
      const key = String(req.query.key || "default").toLowerCase();

      const doc = await homeProductRailsCollection.findOne({ slug, key });

      if (!doc) {
        return res.status(404).json({
          error: { code: "NOT_FOUND", message: "Product rail not configured yet" },
        });
      }

      return res.json({ data: doc });
    } catch (err) {
      console.error("GET /api/admin/home/product-rail error:", err);
      return res.status(500).json({
        error: { code: "SERVER_ERROR", message: "Failed to load admin product rail" },
      });
    }
  }
);

/**
 * Admin: PUT /api/admin/home/product-rail?slug=home&key=baby-musts
 * Body: { enabled?: boolean, title: string, viewAllHref?: string, items: array }
 */
app.put(
  "/api/admin/home/product-rail",
  requireAuth,
  requireRole("admin", "marketing"),
  async (req, res) => {
    try {
      const slug = String(req.query.slug || "home").toLowerCase();
      const key = String(req.query.key || "default").toLowerCase();
      const body = req.body || {};

      if (!Array.isArray(body.items)) {
        return res.status(400).json({
          error: { code: "BAD_REQUEST", message: "items array is required" },
        });
      }

      const items = body.items
        .map((p = {}) => ({
          _id: String(p._id || p.id || crypto.randomBytes(8).toString("hex")),
          title: String(p.title || ""),
          price: typeof p.price === "number" ? p.price : Number(p.price || 0),
          salePrice:
            p.salePrice === null || p.salePrice === undefined || p.salePrice === ""
              ? undefined
              : typeof p.salePrice === "number"
                ? p.salePrice
                : Number(p.salePrice),
          image: String(p.image || ""),
          badge: p.badge ? String(p.badge) : "",
        }))
        .filter((p) => p.title || p.image);

      const now = new Date();

      const updateDoc = {
        slug,
        key,
        enabled: typeof body.enabled === "boolean" ? body.enabled : true,
        title: String(body.title || ""),
        viewAllHref: body.viewAllHref ? String(body.viewAllHref) : "",
        items,
        updatedAt: now,
      };

      const result = await homeProductRailsCollection.findOneAndUpdate(
        { slug, key },
        { $set: updateDoc, $setOnInsert: { createdAt: now } },
        { upsert: true, returnDocument: "after" }
      );

      return res.json({ data: result.value });
    } catch (err) {
      console.error("PUT /api/admin/home/product-rail error:", err);
      return res.status(500).json({
        error: { code: "SERVER_ERROR", message: "Failed to save product rail" },
      });
    }
  }
);


// ------------------- HOMEPAGE HERO WITH RAIL (Dynamic) -------------------
function toHeroWithRailResponse(doc) {
  // supports:
  // 1) { slug, key, enabled, title, viewAllHref, railTitle, railKey, banner:{...} }
  // 2) legacy: { heroWithRail:{...} }
  if (!doc) return null;

  const base =
    doc.heroWithRail && typeof doc.heroWithRail === "object" ? doc.heroWithRail : doc;

  const banner = base.banner && typeof base.banner === "object" ? base.banner : {};

  return {
    title: String(base.title || ""),
    viewAllHref: base.viewAllHref ? String(base.viewAllHref) : "",
    railTitle: base.railTitle ? String(base.railTitle) : "",
    railKey: base.railKey ? String(base.railKey) : "", // this should match home_product_rails.key
    banner: {
      title: String(banner.title || ""),
      subtitle: String(banner.subtitle || ""),
      href: String(banner.href || "/shop"),
      image: String(banner.image || ""),
      cta: String(banner.cta || "Shop"),
      badge: banner.badge ? String(banner.badge) : "",
      theme: banner.theme ? String(banner.theme) : "",
    },
  };
}

/**
 * Public: GET /api/home/hero-with-rail?slug=home&key=gifts-holiday
 * Returns: { data: { title, viewAllHref, railTitle, railKey, banner } }
 */
app.get("/api/home/hero-with-rail", async (req, res) => {
  try {
    const slug = String(req.query.slug || "home").toLowerCase();
    const key = String(req.query.key || "default").toLowerCase();

    const doc = await homeHeroWithRailCollection.findOne({ slug, key });

    if (!doc || doc.enabled === false) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "Hero section not configured yet" },
      });
    }

    return res.json({ data: toHeroWithRailResponse(doc) });
  } catch (err) {
    console.error("GET /api/home/hero-with-rail error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to load hero section" },
    });
  }
});

/**
 * Admin: GET /api/admin/home/hero-with-rail?slug=home&key=gifts-holiday
 */
app.get(
  "/api/admin/home/hero-with-rail",
  requireAuth,
  requireRole("admin", "marketing"),
  async (req, res) => {
    try {
      const slug = String(req.query.slug || "home").toLowerCase();
      const key = String(req.query.key || "default").toLowerCase();

      const doc = await homeHeroWithRailCollection.findOne({ slug, key });

      if (!doc) {
        return res.status(404).json({
          error: { code: "NOT_FOUND", message: "Hero section not configured yet" },
        });
      }

      return res.json({ data: doc });
    } catch (err) {
      console.error("GET /api/admin/home/hero-with-rail error:", err);
      return res.status(500).json({
        error: { code: "SERVER_ERROR", message: "Failed to load admin hero section" },
      });
    }
  }
);

/**
 * Admin: PUT /api/admin/home/hero-with-rail?slug=home&key=gifts-holiday
 * Body: { enabled?: boolean, title, viewAllHref?, railTitle?, railKey?, banner:{...} }
 */
app.put(
  "/api/admin/home/hero-with-rail",
  requireAuth,
  requireRole("admin", "marketing"),
  async (req, res) => {
    try {
      const slug = String(req.query.slug || "home").toLowerCase();
      const key = String(req.query.key || "default").toLowerCase();
      const body = req.body || {};

      if (!body || typeof body !== "object") {
        return res.status(400).json({
          error: { code: "BAD_REQUEST", message: "Body is required" },
        });
      }

      const banner = body.banner && typeof body.banner === "object" ? body.banner : {};

      const now = new Date();
      const updateDoc = {
        slug,
        key,
        enabled: typeof body.enabled === "boolean" ? body.enabled : true,
        title: String(body.title || ""),
        viewAllHref: body.viewAllHref ? String(body.viewAllHref) : "",
        railTitle: body.railTitle ? String(body.railTitle) : "",
        railKey: body.railKey ? String(body.railKey) : "",
        banner: {
          title: String(banner.title || ""),
          subtitle: String(banner.subtitle || ""),
          href: String(banner.href || "/shop"),
          image: String(banner.image || ""),
          cta: String(banner.cta || "Shop"),
          badge: banner.badge ? String(banner.badge) : "",
          theme: banner.theme ? String(banner.theme) : "",
        },
        updatedAt: now,
      };

      const result = await homeHeroWithRailCollection.findOneAndUpdate(
        { slug, key },
        { $set: updateDoc, $setOnInsert: { createdAt: now } },
        { upsert: true, returnDocument: "after" }
      );

      return res.json({ data: result.value });
    } catch (err) {
      console.error("PUT /api/admin/home/hero-with-rail error:", err);
      return res.status(500).json({
        error: { code: "SERVER_ERROR", message: "Failed to save hero section" },
      });
    }
  }
);


// ------------------- HOMEPAGE RAIL WITH BANNER (Dynamic) -------------------
function toRailWithBannerResponse(doc) {
  // supports:
  // 1) { slug, key, enabled, title, viewAllHref, bannerSide, railKey, banner:{...} }
  // 2) legacy: { railWithBanner:{...} }
  if (!doc) return null;

  const base =
    doc.railWithBanner && typeof doc.railWithBanner === "object" ? doc.railWithBanner : doc;

  const banner = base.banner && typeof base.banner === "object" ? base.banner : {};

  return {
    title: String(base.title || ""),
    viewAllHref: base.viewAllHref ? String(base.viewAllHref) : "",
    bannerSide: base.bannerSide === "left" ? "left" : "right",
    railKey: base.railKey ? String(base.railKey) : "",

    banner: {
      title: String(banner.title || ""),
      subtitle: String(banner.subtitle || ""),
      href: String(banner.href || "/shop"),
      image: String(banner.image || ""),
      cta: String(banner.cta || "Shop"),
      badge: banner.badge ? String(banner.badge) : "Featured",
    },
  };
}

/**
 * Public: GET /api/home/rail-with-banner?slug=home&key=save-for-season
 * Returns: { data: { title, viewAllHref, bannerSide, railKey, banner } }
 */
app.get("/api/home/rail-with-banner", async (req, res) => {
  try {
    const slug = String(req.query.slug || "home").toLowerCase();
    const key = String(req.query.key || "default").toLowerCase();

    const doc = await homeRailWithBannerCollection.findOne({ slug, key });

    if (!doc || doc.enabled === false) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "Rail with banner not configured yet" },
      });
    }

    return res.json({ data: toRailWithBannerResponse(doc) });
  } catch (err) {
    console.error("GET /api/home/rail-with-banner error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to load rail with banner" },
    });
  }
});

/**
 * Admin: GET /api/admin/home/rail-with-banner?slug=home&key=save-for-season
 */
app.get(
  "/api/admin/home/rail-with-banner",
  requireAuth,
  requireRole("admin", "marketing"),
  async (req, res) => {
    try {
      const slug = String(req.query.slug || "home").toLowerCase();
      const key = String(req.query.key || "default").toLowerCase();

      const doc = await homeRailWithBannerCollection.findOne({ slug, key });

      if (!doc) {
        return res.status(404).json({
          error: { code: "NOT_FOUND", message: "Rail with banner not configured yet" },
        });
      }

      return res.json({ data: doc });
    } catch (err) {
      console.error("GET /api/admin/home/rail-with-banner error:", err);
      return res.status(500).json({
        error: { code: "SERVER_ERROR", message: "Failed to load admin rail with banner" },
      });
    }
  }
);

/**
 * Admin: PUT /api/admin/home/rail-with-banner?slug=home&key=save-for-season
 * Body: { enabled?: boolean, title, viewAllHref?, bannerSide?, railKey?, banner:{...} }
 */
app.put(
  "/api/admin/home/rail-with-banner",
  requireAuth,
  requireRole("admin", "marketing"),
  async (req, res) => {
    try {
      const slug = String(req.query.slug || "home").toLowerCase();
      const key = String(req.query.key || "default").toLowerCase();
      const body = req.body || {};

      const banner = body.banner && typeof body.banner === "object" ? body.banner : {};

      const now = new Date();
      const updateDoc = {
        slug,
        key,
        enabled: typeof body.enabled === "boolean" ? body.enabled : true,

        title: String(body.title || ""),
        viewAllHref: body.viewAllHref ? String(body.viewAllHref) : "",
        bannerSide: body.bannerSide === "left" ? "left" : "right",
        railKey: body.railKey ? String(body.railKey) : "",

        banner: {
          title: String(banner.title || ""),
          subtitle: String(banner.subtitle || ""),
          href: String(banner.href || "/shop"),
          image: String(banner.image || ""),
          cta: String(banner.cta || "Shop"),
          badge: banner.badge ? String(banner.badge) : "Featured",
        },

        updatedAt: now,
      };

      const result = await homeRailWithBannerCollection.findOneAndUpdate(
        { slug, key },
        { $set: updateDoc, $setOnInsert: { createdAt: now } },
        { upsert: true, returnDocument: "after" }
      );

      return res.json({ data: result.value });
    } catch (err) {
      console.error("PUT /api/admin/home/rail-with-banner error:", err);
      return res.status(500).json({
        error: { code: "SERVER_ERROR", message: "Failed to save rail with banner" },
      });
    }
  }
);


// ------------------- HOMEPAGE DEPARTMENTS (Dynamic) -------------------
function toDepartmentsResponse(doc) {
  if (!doc) return null;

  const base =
    doc.departments && typeof doc.departments === "object"
      ? doc.departments
      : doc;

  const items = Array.isArray(base.items) ? base.items : Array.isArray(doc.items) ? doc.items : [];

  return {
    title: String(base.title || "Shop by department"),
    viewAllHref: base.viewAllHref ? String(base.viewAllHref) : "/shop",
    items: items.map((d = {}) => ({
      id: String(d.id || d._id || Math.random().toString(16).slice(2)),
      label: String(d.label || d.title || ""),
      href: String(d.href || "/shop"),
      image: d.image ? String(d.image) : "",
    })),
  };
}

/**
 * Public: GET /api/home/departments?slug=home
 * Returns: { data: { title, viewAllHref, items:[...] } }
 */
app.get("/api/home/departments", async (req, res) => {
  try {
    const slug = String(req.query.slug || "home").toLowerCase();
    const doc = await homeDepartmentsCollection.findOne({ slug });

    if (!doc || doc.enabled === false) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "Departments not configured yet" },
      });
    }

    return res.json({ data: toDepartmentsResponse(doc) });
  } catch (err) {
    console.error("GET /api/home/departments error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to load departments" },
    });
  }
});

/**
 * Admin: GET /api/admin/home/departments?slug=home
 */
app.get(
  "/api/admin/home/departments",
  requireAuth,
  requireRole("admin", "marketing"),
  async (req, res) => {
    try {
      const slug = String(req.query.slug || "home").toLowerCase();
      const doc = await homeDepartmentsCollection.findOne({ slug });

      if (!doc) {
        return res.status(404).json({
          error: { code: "NOT_FOUND", message: "Departments not configured yet" },
        });
      }

      return res.json({ data: doc });
    } catch (err) {
      console.error("GET /api/admin/home/departments error:", err);
      return res.status(500).json({
        error: { code: "SERVER_ERROR", message: "Failed to load admin departments" },
      });
    }
  }
);

/**
 * Admin: PUT /api/admin/home/departments?slug=home
 * Body: { enabled?: boolean, title?, viewAllHref?, items:[{id,label,href,image}] }
 */
app.put(
  "/api/admin/home/departments",
  requireAuth,
  requireRole("admin", "marketing"),
  async (req, res) => {
    try {
      const slug = String(req.query.slug || "home").toLowerCase();
      const body = req.body || {};

      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) {
        return res.status(400).json({
          error: { code: "BAD_REQUEST", message: "items array is required" },
        });
      }

      const now = new Date();

      const updateDoc = {
        slug,
        enabled: typeof body.enabled === "boolean" ? body.enabled : true,
        title: body.title ? String(body.title) : "Shop by department",
        viewAllHref: body.viewAllHref ? String(body.viewAllHref) : "/shop",
        items: items.map((d = {}) => ({
          id: String(d.id || d._id || Math.random().toString(16).slice(2)),
          label: String(d.label || d.title || ""),
          href: String(d.href || "/shop"),
          image: d.image ? String(d.image) : "",
        })),
        updatedAt: now,
      };

      const result = await homeDepartmentsCollection.findOneAndUpdate(
        { slug },
        { $set: updateDoc, $setOnInsert: { createdAt: now } },
        { upsert: true, returnDocument: "after" }
      );

      return res.json({ data: result.value });
    } catch (err) {
      console.error("PUT /api/admin/home/departments error:", err);
      return res.status(500).json({
        error: { code: "SERVER_ERROR", message: "Failed to save departments" },
      });
    }
  }
);


// ------------------- HOMEPAGE RAIL SECTION (Dynamic) -------------------
function toRailSectionResponse(doc) {
  if (!doc) return null;

  const base =
    doc.railSection && typeof doc.railSection === "object" ? doc.railSection : doc;

  return {
    title: String(base.title || ""),
    viewAllHref: base.viewAllHref ? String(base.viewAllHref) : "",
    rightText: base.rightText ? String(base.rightText) : "",
    railKey: base.railKey ? String(base.railKey) : "",
  };
}

/**
 * Public: GET /api/home/rail-section?slug=home&key=weekly-flyer
 * Returns: { data: { title, viewAllHref, rightText, railKey } }
 */
app.get("/api/home/rail-section", async (req, res) => {
  try {
    const slug = String(req.query.slug || "home").toLowerCase();
    const key = String(req.query.key || "default").toLowerCase();

    const doc = await homeRailSectionsCollection.findOne({ slug, key });

    if (!doc || doc.enabled === false) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "Rail section not configured yet" },
      });
    }

    return res.json({ data: toRailSectionResponse(doc) });
  } catch (err) {
    console.error("GET /api/home/rail-section error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to load rail section" },
    });
  }
});

/**
 * Admin: GET /api/admin/home/rail-section?slug=home&key=weekly-flyer
 */
app.get(
  "/api/admin/home/rail-section",
  requireAuth,
  requireRole("admin", "marketing"),
  async (req, res) => {
    try {
      const slug = String(req.query.slug || "home").toLowerCase();
      const key = String(req.query.key || "default").toLowerCase();

      const doc = await homeRailSectionsCollection.findOne({ slug, key });

      if (!doc) {
        return res.status(404).json({
          error: { code: "NOT_FOUND", message: "Rail section not configured yet" },
        });
      }

      return res.json({ data: doc });
    } catch (err) {
      console.error("GET /api/admin/home/rail-section error:", err);
      return res.status(500).json({
        error: { code: "SERVER_ERROR", message: "Failed to load admin rail section" },
      });
    }
  }
);

/**
 * Admin: PUT /api/admin/home/rail-section?slug=home&key=weekly-flyer
 * Body: { enabled?: boolean, title, viewAllHref?, rightText?, railKey }
 */
app.put(
  "/api/admin/home/rail-section",
  requireAuth,
  requireRole("admin", "marketing"),
  async (req, res) => {
    try {
      const slug = String(req.query.slug || "home").toLowerCase();
      const key = String(req.query.key || "default").toLowerCase();
      const body = req.body || {};

      if (!body || typeof body !== "object") {
        return res.status(400).json({
          error: { code: "BAD_REQUEST", message: "Body is required" },
        });
      }

      if (!body.railKey) {
        return res.status(400).json({
          error: { code: "BAD_REQUEST", message: "railKey is required" },
        });
      }

      const now = new Date();

      const updateDoc = {
        slug,
        key,
        enabled: typeof body.enabled === "boolean" ? body.enabled : true,
        title: String(body.title || ""),
        viewAllHref: body.viewAllHref ? String(body.viewAllHref) : "",
        rightText: body.rightText ? String(body.rightText) : "",
        railKey: String(body.railKey || ""),
        updatedAt: now,
      };

      const result = await homeRailSectionsCollection.findOneAndUpdate(
        { slug, key },
        { $set: updateDoc, $setOnInsert: { createdAt: now } },
        { upsert: true, returnDocument: "after" }
      );

      return res.json({ data: result.value });
    } catch (err) {
      console.error("PUT /api/admin/home/rail-section error:", err);
      return res.status(500).json({
        error: { code: "SERVER_ERROR", message: "Failed to save rail section" },
      });
    }
  }
);



// ------------------- PRODUCTS (Search + Sort + Filters + Facets + Pagination) -------------------
/**
 * GET /api/products
 * Params:
 * - q, category, minPrice, maxPrice, inStock=true/false
 * - brand=Apple&brand=Sony
 * - tag=vegan&tag=halal
 * - sort=featured|newest|price_asc|price_desc
 * - page, limit
 */

// ------------------- Product Suggest (SearchBox) -------------------
// GET /api/products/suggest?q=milk&limit=8
app.get("/api/products/suggest", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit || "8", 10), 1), 20);

    if (!q) return res.json({ data: { items: [] } });

    // simple + reliable (no text-index dependency)
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    const items = await productsCollection
      .find(
        {
          isActive: { $ne: false },
          $or: [{ name: rx }, { brand: rx }],
        },
        {
          projection: {
            name: 1,
            slug: 1,
            price: 1,
            oldPrice: 1,
            image: 1,
            brand: 1,
            inStock: 1,
            createdAt: 1,
          },
        }
      )
      .sort({ inStock: -1, createdAt: -1 })
      .limit(limit)
      .toArray();

    return res.json({ data: { items } });
  } catch (err) {
    console.error("GET /api/products/suggest error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to load suggestions" },
    });
  }
});
// ------------------- PRODUCTS (Category + Search with facets + pagination) -------------------
// GET /api/products
app.get("/api/products", async (req, res) => {
  try {
    const {
      q = "",
      search = "",
      category = "",
      minPrice,
      maxPrice,
      inStock,
      sort = "featured",
      page = "1",
      limit = "20",
    } = req.query;

    const searchTerm = String(q || search || "").trim();
    const hasQ = !!searchTerm;

    const brand = req.query.brand;
    const brands = Array.isArray(brand) ? brand : brand ? [brand] : [];

    const tag = req.query.tag;
    const tags = Array.isArray(tag) ? tag : tag ? [tag] : [];

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 60);
    const skip = (pageNum - 1) * limitNum;

    const filter = { isActive: { $ne: false } };

    if (category) filter.categorySlug = category;

    if (hasQ) filter.$text = { $search: searchTerm };


    // price filter (convert params to number safely)
    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }

    if (inStock === "true") filter.inStock = true;
    if (inStock === "false") filter.inStock = false;

    if (brands.length) filter.brand = { $in: brands };
    if (tags.length) filter.tags = { $all: tags };

    // ✅ Robust fields for sorting even if DB has strings/missing createdAt
    const addFieldsStage = {
      $addFields: {
        // fallback to ObjectId timestamp if createdAt missing
        createdAtDate: { $ifNull: ["$createdAt", { $toDate: "$_id" }] },

        // convert price to number safely (works if price is "120" or 120)
        priceNum: {
          $convert: { input: "$price", to: "double", onError: null, onNull: null },
        },

        // for $text query sorting
        ...(hasQ ? { score: { $meta: "textScore" } } : {}),
      },
    };

    // ✅ Sort mapping (use priceNum / createdAtDate)
    const sortMap = {
      featured: hasQ ? { score: -1, createdAtDate: -1 } : { createdAtDate: -1 },
      newest: { createdAtDate: -1 },
      price_asc: { priceNum: 1, createdAtDate: -1 },
      price_desc: { priceNum: -1, createdAtDate: -1 },
    };
    const sortStage = sortMap[sort] || sortMap.featured;

    const pipeline = [
      { $match: filter },
      addFieldsStage,
      {
        $facet: {
          items: [
            { $sort: sortStage },
            { $skip: skip },
            { $limit: limitNum },
            {
              $project: {
                name: 1,
                slug: 1,
                brand: 1,
                categorySlug: 1,
                image: 1,
                inStock: 1,
                tags: 1,
                rating: 1,
                reviewCount: 1,

                // return numeric price (fallback to original)
                price: { $ifNull: ["$priceNum", "$price"] },
                oldPrice: 1,

                createdAt: "$createdAtDate",
                ...(hasQ ? { score: 1 } : {}),
              },
            },
          ],
          totalCount: [{ $count: "count" }],
          brands: [
            { $match: { brand: { $type: "string" } } },
            { $group: { _id: "$brand", count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
            { $limit: 25 },
          ],
          tags: [
            { $unwind: { path: "$tags", preserveNullAndEmptyArrays: false } },
            { $group: { _id: "$tags", count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
            { $limit: 25 },
          ],
          priceRange: [
            {
              $group: {
                _id: null,
                min: { $min: "$priceNum" },
                max: { $max: "$priceNum" },
              },
            },
          ],
        },
      },
    ];

    const agg = await productsCollection.aggregate(pipeline).toArray();
    const out = agg?.[0] || {};

    const items = out.items || [];
    const total = out.totalCount?.[0]?.count || 0;
    const pages = Math.max(Math.ceil(total / limitNum), 1);

    return res.json({
      data: {
        items,
        pagination: { total, page: pageNum, pages, limit: limitNum },
        facets: {
          brands: (out.brands || []).filter((b) => b._id).map((b) => ({ name: b._id, count: b.count })),
          tags: (out.tags || []).filter((t) => t._id).map((t) => ({ name: t._id, count: t.count })),
          priceRange: out.priceRange?.[0] || { min: 0, max: 0 },
        },
      },
    });
  } catch (err) {
    console.error("GET /api/products error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load products" } });
  }
});


// ------------------- PRODUCT DETAILS -------------------

// helper: check ObjectId
function isValidObjectId(id) {
  return ObjectId.isValid(id) && String(new ObjectId(id)) === id;
}

/**
 * GET /api/products/:idOrSlug
 * supports: ObjectId or slug
 */
app.get("/api/products/:idOrSlug", async (req, res) => {
  try {
    const idOrSlug = String(req.params.idOrSlug || "").trim();

    const query = isValidObjectId(idOrSlug)
      ? { _id: new ObjectId(idOrSlug) }
      : { slug: idOrSlug };

    const product = await productsCollection.findOne(query);

    if (!product || product.isActive === false) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "Product not found" },
      });
    }

    return res.json({ data: { product } });
  } catch (err) {
    console.error("GET /api/products/:idOrSlug error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to load product" },
    });
  }
});

/**
 * GET /api/products/:idOrSlug/related?limit=12
 * basic related: same category or shared tags
 */
app.get("/api/products/:idOrSlug/related", async (req, res) => {
  try {
    const idOrSlug = String(req.params.idOrSlug || "").trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit || "12", 10), 1), 24);

    const query = isValidObjectId(idOrSlug)
      ? { _id: new ObjectId(idOrSlug) }
      : { slug: idOrSlug };

    const base = await productsCollection.findOne(query, {
      projection: { _id: 1, categorySlug: 1, tags: 1, brand: 1 },
    });

    if (!base) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Product not found" } });
    }

    const and = [{ isActive: { $ne: false } }, { _id: { $ne: base._id } }];

    // prefer tags match; fallback to category
    const or = [];
    if (Array.isArray(base.tags) && base.tags.length) {
      or.push({ tags: { $in: base.tags.slice(0, 6) } });
    }
    if (base.categorySlug) {
      or.push({ categorySlug: base.categorySlug });
    }
    if (base.brand) {
      or.push({ brand: base.brand });
    }

    const related = await productsCollection
      .find(or.length ? { $and: and.concat([{ $or: or }]) } : { $and: and })
      .project({
        name: 1,
        slug: 1,
        price: 1,
        oldPrice: 1,
        brand: 1,
        image: 1,
        images: 1,
        inStock: 1,
        rating: 1,
        reviewCount: 1,
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    return res.json({ data: { items: related } });
  } catch (err) {
    console.error("GET /api/products/:idOrSlug/related error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to load related items" },
    });
  }
});

/**
 * GET /api/products/:idOrSlug/fbt?limit=3
 * "Frequently bought together": pick 2-3 items from same tags/category
 */
app.get("/api/products/:idOrSlug/fbt", async (req, res) => {
  try {
    const idOrSlug = String(req.params.idOrSlug || "").trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit || "3", 10), 2), 6);

    const query = isValidObjectId(idOrSlug)
      ? { _id: new ObjectId(idOrSlug) }
      : { slug: idOrSlug };

    const base = await productsCollection.findOne(query);

    if (!base || base.isActive === false) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Product not found" } });
    }

    const and = [{ isActive: { $ne: false } }, { _id: { $ne: base._id } }];

    const or = [];
    if (Array.isArray(base.tags) && base.tags.length) {
      or.push({ tags: { $in: base.tags.slice(0, 6) } });
    }
    if (base.categorySlug) {
      or.push({ categorySlug: base.categorySlug });
    }

    const items = await productsCollection
      .find(or.length ? { $and: and.concat([{ $or: or }]) } : { $and: and })
      .project({
        name: 1,
        slug: 1,
        price: 1,
        oldPrice: 1,
        brand: 1,
        image: 1,
        images: 1,
        inStock: 1,
        rating: 1,
        reviewCount: 1,
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    // return base + suggestions
    return res.json({
      data: {
        base: {
          _id: base._id,
          name: base.name,
          slug: base.slug,
          price: base.price,
          oldPrice: base.oldPrice,
          image: base.image,
          images: base.images,
          inStock: base.inStock,
        },
        items,
      },
    });
  } catch (err) {
    console.error("GET /api/products/:idOrSlug/fbt error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to load frequently bought together" },
    });
  }
});


// (Optional but helpful) categories list to avoid frontend 404 if you request /api/categories
app.get("/api/categories", async (_req, res) => {
  try {
    const pipeline = [
      { $match: { isActive: { $ne: false }, categorySlug: { $type: "string" } } },
      { $group: { _id: "$categorySlug", count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 100 },
    ];
    const rows = await productsCollection.aggregate(pipeline).toArray();
    res.json({ data: rows.map((r) => ({ slug: r._id, count: r.count })) });
  } catch (err) {
    console.error("GET /api/categories error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load categories" } });
  }
});




// ✅ GET /api/products/suggest?q=milk



// GET /api/delivery/slots?mode=delivery|pickup&date=YYYY-MM-DD
app.get("/api/delivery/slots", async (req, res) => {
  const mode = String(req.query.mode || "delivery");
  const date = String(req.query.date || new Date().toISOString().slice(0, 10));

  // simple static slots
  const base = [
    { id: "s1", label: "10:00 AM - 12:00 PM", start: "10:00", end: "12:00" },
    { id: "s2", label: "12:00 PM - 02:00 PM", start: "12:00", end: "14:00" },
    { id: "s3", label: "02:00 PM - 04:00 PM", start: "14:00", end: "16:00" },
    { id: "s4", label: "04:00 PM - 06:00 PM", start: "16:00", end: "18:00" },
  ];

  const slots = base.map((s) => ({
    ...s,
    date,
    dayKey: `${mode}:${date}`,
    remaining: 50,
    arrivesText: mode === "pickup" ? "Pick up within this window." : "Arrives within this window.",
  }));

  res.json({ data: { slots } });
});


// POST /api/payments/create-intent
// Body: { mode, address, slot, items:[{productId, qty}] }
// at top: const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// ------------------- Helpers (put near your other helpers) -------------------
function makeOrderNumber() {
  // always a string (prevents duplicate key on null)
  return `TV-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`.toUpperCase();
}

function toObjectIdSafe(id) {
  const s = String(id || "").trim();
  if (!ObjectId.isValid(s)) return null;
  return new ObjectId(s);
}

// ------------------- STRIPE: create intent + draft order -------------------
// POST /api/payments/create-intent
// Body: { mode, address, slot, items:[{productId, qty}] }
app.post("/api/payments/create-intent", requireAuth, async (req, res) => {
  try {
    if (!ordersCollection || !productsCollection) {
      return res.status(503).json({ error: { code: "NOT_READY", message: "DB not ready yet" } });
    }

    const { mode = "delivery", address = null, slot = null, items = [] } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "items is required" } });
    }

    // Normalize items
    const normalized = items
      .map((it) => ({
        productId: String(it.productId || "").trim(),
        qty: Math.max(1, parseInt(it.qty, 10) || 1),
      }))
      .filter((it) => it.productId);

    if (!normalized.length) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "No valid items" } });
    }

    // Convert productIds to ObjectIds safely
    const productIds = normalized.map((x) => toObjectIdSafe(x.productId));
    if (productIds.some((x) => !x)) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid productId in items" } });
    }

    // Fetch products (price from DB only)
    const products = await productsCollection
      .find({ _id: { $in: productIds }, isActive: { $ne: false } })
      .project({ name: 1, slug: 1, price: 1, image: 1, inStock: 1 })
      .toArray();

    const byId = new Map(products.map((p) => [String(p._id), p]));

    const orderItems = [];
    for (const it of normalized) {
      const p = byId.get(it.productId);
      if (!p) {
        return res.status(400).json({
          error: { code: "BAD_REQUEST", message: `Invalid productId: ${it.productId}` },
        });
      }

      const price = Number(p.price || 0);
      if (price <= 0) {
        return res.status(400).json({
          error: { code: "BAD_REQUEST", message: `Invalid price for product: ${p.name || it.productId}` },
        });
      }

      orderItems.push({
        productId: it.productId, // string version of ObjectId
        name: p.name || "",
        slug: p.slug || "",
        image: p.image || "",
        price,
        qty: it.qty,
        inStock: p.inStock !== false,
      });
    }

    const subtotal = orderItems.reduce((sum, it) => sum + it.price * it.qty, 0);
    const deliveryFee = mode === "delivery" ? (subtotal >= 2000 ? 0 : 60) : 0;
    const total = subtotal + deliveryFee;

    if (total <= 0) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid total amount" } });
    }

    // Stripe amount in smallest unit
    const amount = Math.round(total * 100); // BDT -> poisha
    const now = new Date();
    const orderNumber = makeOrderNumber();

    // Create PaymentIntent
    const pi = await stripe.paymentIntents.create({
      amount,
      currency: "bdt",
      automatic_payment_methods: { enabled: true },
      metadata: {
        userId: String(req.user._id),        // ✅ string for Stripe
        firebaseUid: String(req.user.firebaseUid || ""),
        mode: String(mode),
      },
    });

    const owner = buildOwner(req.user);


    // ✅ Draft order (IMPORTANT: userId is ObjectId)
    const draft = {
      orderNumber: makeOrderNumber(),
      owner,                    // ✅ NEW
      userId: owner.userId,     // ✅ keep for compatibility
      firebaseUid: owner.firebaseUid,
      email: owner.email,

      mode,
      address: mode === "delivery" ? address : null,
      slot: slot || null,
      items: orderItems,

      subtotal,
      deliveryFee,
      total,

      payment: {
        method: "card",
        status: "requires_payment",
        stripe: { paymentIntentId: pi.id },
      },

      status: "pending_payment",
      timeline: [
        timelineEntry({
          status: "pending_payment",
          note: "Payment initiated (Stripe)",
          byUser: req.user,
        }),
      ],

      createdAt: now,
      updatedAt: now,
    };

    const ins = await ordersCollection.insertOne(draft);

    return res.json({
      data: {
        clientSecret: pi.client_secret,
        paymentIntentId: pi.id,
        orderId: ins.insertedId.toString(), // ✅ string for frontend
        amount,
        currency: "bdt",
        pricing: { subtotal, deliveryFee, total },
      },
    });
  } catch (err) {
    console.error("POST /api/payments/create-intent error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: err?.message || "Failed to create intent" },
    });
  }
});

// ------------------- COD: place order -------------------
// POST /api/orders
// Body: { mode, address, slot, paymentMethod:"cod", items:[{productId, qty}] }
// POST /api/orders  (COD ONLY)
// Body: { mode, address, slot, items:[{productId, qty}], paymentMethod:"cod" }
app.post("/api/orders", requireAuth, async (req, res) => {
  try {
    if (!ordersCollection || !productsCollection) {
      return res.status(503).json({ error: { code: "NOT_READY", message: "DB not ready yet" } });
    }

    const mode = String(req.body?.mode || "delivery");
    const address = mode === "delivery" ? (req.body?.address || null) : null;
    const slot = req.body?.slot || null;

    const paymentMethod = String(req.body?.paymentMethod || "cod").toLowerCase();
    if (paymentMethod !== "cod") {
      return res.status(400).json({
        error: {
          code: "BAD_REQUEST",
          message: "For card payments, use /api/payments/create-intent then /api/payments/finalize (do not call /api/orders).",
        },
      });
    }

    const itemsReq = Array.isArray(req.body?.items) ? req.body.items : [];
    const checkout = await buildCheckoutFromItems({ items: itemsReq, mode });

    const now = new Date();

    // ✅ DEFINE payment (this fixes your error)
    const payment = {
      method: "cod",
      status: "unpaid",
    };

    const orderDoc = {
      orderNumber: makeOrderNumber(), // must be string
      userId: String(req.user._id),   // keep consistent with requireAuth + owner checks
      email: req.user.email || "",

      mode,
      address,
      slot,

      items: checkout.items,
      subtotal: checkout.subtotal,
      deliveryFee: checkout.deliveryFee,
      total: checkout.total,

      payment,
      status: "placed",

      createdAt: now,
      updatedAt: now,
    };

    const ins = await ordersCollection.insertOne(orderDoc);
    orderDoc._id = ins.insertedId;

    return res.json({ data: { order: orderDoc } });
  } catch (err) {
    console.error("POST /api/orders error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: err?.message || "Failed to place order" },
    });
  }
});


// ------------------- STRIPE: finalize payment (mark order paid) -------------------
// POST /api/payments/finalize
// Body: { orderId, paymentIntentId }
app.post("/api/payments/finalize", requireAuth, async (req, res) => {
  try {
    if (!ordersCollection) {
      return res.status(503).json({ error: { code: "NOT_READY", message: "DB not ready yet" } });
    }

    const { orderId, paymentIntentId } = req.body || {};
    if (!orderId || !paymentIntentId) {
      return res.status(400).json({
        error: { code: "BAD_REQUEST", message: "orderId and paymentIntentId are required" },
      });
    }

    const oid = toObjectIdSafe(orderId);
    if (!oid) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid orderId" } });
    }

    const order = await ordersCollection.findOne({ _id: oid });
    if (!order) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Order not found" } });
    }

    // ✅ Owner check (ObjectId)
    if (String(order.userId) !== String(req.user._id)) {
      return res.status(403).json({ error: { code: "FORBIDDEN", message: "Not your order" } });
    }

    // Verify PI status from Stripe
    const pi = await stripe.paymentIntents.retrieve(String(paymentIntentId));
    if (pi.status !== "succeeded") {
      return res.status(400).json({
        error: { code: "PAYMENT_NOT_SUCCEEDED", message: `PaymentIntent status: ${pi.status}` },
      });
    }

    // Optional: match PI with the one stored in draft
    const storedPI = order?.payment?.stripe?.paymentIntentId;
    if (storedPI && String(storedPI) !== String(pi.id)) {
      return res.status(400).json({
        error: { code: "BAD_REQUEST", message: "PaymentIntent does not match this order" },
      });
    }

    const now = new Date();

    await ordersCollection.updateOne(
      { _id: new ObjectId(orderId) },
      {
        $set: {
          status: "placed",
          updatedAt: now,
          "payment.status": "paid",
          "payment.stripe.paymentIntentId": pi.id,
          "payment.stripe.receiptEmail": pi.receipt_email || "",
        },
        $push: {
          timeline: timelineEntry({
            status: "placed",
            note: "Payment confirmed (Stripe)",
            byUser: req.user,
          }),
        },
      }
    );


    const updated = await ordersCollection.findOne({ _id: oid });

    return res.json({ data: { order: updated } });
  } catch (err) {
    console.error("POST /api/payments/finalize error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: err?.message || "Failed to finalize payment" },
    });
  }
});





// ------------------- ORDERS -------------------

// GET /api/orders/my  (list my orders)
// helper: safe ObjectId
function isValidObjectId(id) {
  return ObjectId.isValid(id) && String(new ObjectId(id)) === String(id);
}

/**
 * GET /api/orders
 * Returns logged-in user's orders (My Orders page)
 */
app.get("/api/orders", requireAuth, async (req, res) => {
  try {
    if (!ordersCollection) {
      return res.status(503).json({ error: { code: "NOT_READY", message: "DB not ready yet" } });
    }

    const myId = req.user._id; // ObjectId
    const myIdStr = String(req.user._id);

    // Support both new (ObjectId) + old (string) orders so existing data still works:
    const orders = await ordersCollection
      .find({ $or: [{ userId: myId }, { userId: myIdStr }] })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    return res.json({ data: { orders } });
  } catch (err) {
    console.error("GET /api/orders error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load orders" } });
  }
});


/**
 * GET /api/orders/:id
 * Returns one order if owned by logged-in user
 */
// GET /api/orders/:id
app.get("/api/orders/:id", requireAuth, async (req, res) => {
  try {
    if (!ordersCollection) {
      return res.status(503).json({ error: { code: "NOT_READY", message: "DB not ready yet" } });
    }

    const id = String(req.params.id || "");
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid order id" } });
    }

    const order = await ordersCollection.findOne({ _id: new ObjectId(id) });
    if (!order) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Order not found" } });

    if (!isOrderOwner(order, req.user) && req.user.role !== "admin") {
      return res.status(403).json({ error: { code: "FORBIDDEN", message: "Forbidden" } });
    }

    return res.json({ data: { order } });
  } catch (err) {
    console.error("GET /api/orders/:id error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load order" } });
  }
});


// GET /api/orders/my
app.get("/api/orders/my", requireAuth, async (req, res) => {
  try {
    if (!ordersCollection) {
      return res.status(503).json({ error: { code: "NOT_READY", message: "DB not ready yet" } });
    }

    const uid = String(req.user._id);
    const fuid = String(req.user.firebaseUid || "");

    const match = {
      $or: [
        { "owner.userId": uid },
        { userId: uid },
        ...(fuid ? [{ "owner.firebaseUid": fuid }, { firebaseUid: fuid }] : []),
      ],
    };

    const items = await ordersCollection
      .find(match)
      .sort({ createdAt: -1 })
      .limit(50)
      .project({
        orderNumber: 1,
        status: 1,
        mode: 1,
        total: 1,
        createdAt: 1,
        updatedAt: 1,
        payment: 1,
        items: 1,
      })
      .toArray();

    return res.json({ data: { items } });
  } catch (err) {
    console.error("GET /api/orders/my error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load orders" } });
  }
});




// ✅ Admin overview dashboard summary
// ------------------- ADMIN -------------------
// ------------------- ADMIN ROUTER (FIX ALL 404s) -------------------
const adminRouter = express.Router();

adminRouter.use(requireAuth);
// adminRouter.use(requireRole("admin", "manager"));

// ----- Roles -----
const ROLES = {
  ADMIN: "admin",
  MANAGER: "manager",
  SUPPORT: "support",
  DELIVERY: "delivery",
};


// If you already have requireRole() in index.js, use yours.
// Otherwise keep this:
function requireRole(...roles) {
  return (req, res, next) => {
    const role = String(req.user?.role || "");
    if (!roles.includes(role)) {
      return res.status(403).json({
        error: { code: "FORBIDDEN", message: `Requires role: ${roles.join(", ")}` },
      });
    }
    next();
  };
}

function mustBeAdmin(req, res, next) {
  if (String(req.user?.role || "") !== ROLES.ADMIN) {
    return res.status(403).json({
      error: { code: "FORBIDDEN", message: "Only admin can do this" },
    });
  }
  next();
}

function isValidObjectId(id) {
  return ObjectId.isValid(id) && String(new ObjectId(id)) === String(id);
}
function toObjectId(id) {
  return new ObjectId(String(id));
}


// GET /api/admin/overview
// ------------------- OVERVIEW -------------------
// GET /api/admin/overview  (admin + manager)
adminRouter.get("/overview", requireRole(ROLES.ADMIN, ROLES.MANAGER), async (_req, res) => {
  try {
    if (!usersCollection || !productsCollection || !ordersCollection) {
      return res.status(503).json({ error: { code: "NOT_READY", message: "DB not ready yet" } });
    }

    const [users, products, orders] = await Promise.all([
      usersCollection.estimatedDocumentCount(),
      productsCollection.estimatedDocumentCount(),
      ordersCollection.estimatedDocumentCount(),
    ]);

    const paidOrders = await ordersCollection.countDocuments({ "payment.status": "paid" });
    const unpaidOrders = await ordersCollection.countDocuments({ "payment.status": { $ne: "paid" } });

    const revenueAgg = await ordersCollection
      .aggregate([
        { $match: { "payment.status": "paid", status: { $ne: "cancelled" } } },
        { $group: { _id: null, revenue: { $sum: "$total" } } },
      ])
      .toArray();

    const revenue = revenueAgg?.[0]?.revenue || 0;

    const byStatus = await ordersCollection
      .aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
        { $project: { _id: 0, status: "$_id", count: 1 } },
        { $sort: { count: -1 } },
      ])
      .toArray();

    res.json({ data: { totals: { users, products, orders, paidOrders, unpaidOrders, revenue }, byStatus } });
  } catch (err) {
    console.error("GET /api/admin/overview error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load overview" } });
  }
});

// GET /api/admin/orders
// ------------------- ORDERS -------------------
// GET /api/admin/orders  (admin + manager)
adminRouter.get("/orders", requireRole(ROLES.ADMIN, ROLES.MANAGER), async (req, res) => {
  try {
    const { status = "", payment = "", mode = "", q = "", page = "1", limit = "20" } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const filter = {};
    if (status) filter.status = String(status);
    if (payment) filter["payment.status"] = String(payment);
    if (mode) filter.mode = String(mode);

    const queryText = String(q || "").trim();
    if (queryText) {
      if (isValidObjectId(queryText)) filter._id = toObjectId(queryText);
      else {
        const rx = new RegExp(escapeRegex(queryText), "i");
        filter.$or = [{ orderNumber: rx }, { email: rx }];
      }
    }

    const [items, total] = await Promise.all([
      ordersCollection
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .toArray(),
      ordersCollection.countDocuments(filter),
    ]);

    res.json({
      data: {
        orders: items,
        pagination: { total, page: pageNum, pages: Math.max(Math.ceil(total / limitNum), 1), limit: limitNum },
      },
    });
  } catch (err) {
    console.error("GET /api/admin/orders error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load orders" } });
  }
});

// PATCH /api/admin/orders/:id/status   ✅ this is what your frontend calls
adminRouter.patch("/orders/:id/status", requireRole(ROLES.ADMIN, ROLES.MANAGER), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid order id" } });
    }

    const status = String(req.body?.status || "").trim();
    const note = String(req.body?.note || "").trim();

    if (!ORDER_STATUSES.has(status)) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid status" } });
    }

    const now = new Date();

    const upd = await ordersCollection.findOneAndUpdate(
      { _id: toObjectId(id) },
      {
        $set: { status, updatedAt: now },
        $push: {
          statusHistory: {
            status,
            at: now,
            note,
            by: String(req.user._id),
            byEmail: req.user.email || "",
          },
        },
      },
      { returnDocument: "after" }
    );

    if (!upd.value) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Order not found" } });

    res.json({ data: { order: upd.value } });
  } catch (err) {
    console.error("PATCH /api/admin/orders/:id/status error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to update order status" } });
  }
});

// GET /api/admin/products
// -------------------- PRODUCTS -------------------
// GET /api/admin/products  (admin + manager)
adminRouter.get("/products", requireRole(ROLES.ADMIN, ROLES.MANAGER), async (req, res) => {
  try {
    const { q = "", page = "1", limit = "20" } = req.query;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const filter = { isActive: { $ne: false } };
    const queryText = String(q || "").trim();
    if (queryText) {
      const rx = new RegExp(escapeRegex(queryText), "i");
      filter.$or = [{ name: rx }, { brand: rx }, { slug: rx }, { categorySlug: rx }];
    }

    const [items, total] = await Promise.all([
      productsCollection.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).toArray(),
      productsCollection.countDocuments(filter),
    ]);

    res.json({ data: { items, pagination: { total, page: pageNum, pages: Math.max(Math.ceil(total / limitNum), 1), limit: limitNum } } });
  } catch (err) {
    console.error("GET /api/admin/products error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load products" } });
  }
});

// POST /api/admin/products
adminRouter.post("/products", requireRole(ROLES.ADMIN, ROLES.MANAGER), async (req, res) => {
  try {
    const now = new Date();
    const b = req.body || {};

    const doc = {
      name: String(b.name || "").trim(),
      slug: String(b.slug || "").trim(),
      brand: String(b.brand || "").trim(),
      categorySlug: String(b.categorySlug || "").trim(),
      price: Number(b.price || 0),
      oldPrice: b.oldPrice != null ? Number(b.oldPrice) : null,
      image: String(b.image || "").trim(),
      images: Array.isArray(b.images) ? b.images.map(String) : [],
      tags: Array.isArray(b.tags) ? b.tags.map(String) : [],
      inStock: b.inStock !== false,
      isActive: b.isActive !== false,
      createdAt: now,
      updatedAt: now,
    };

    if (!doc.name || !doc.slug || !doc.categorySlug) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "name, slug, categorySlug are required" } });
    }

    const ins = await productsCollection.insertOne(doc);
    doc._id = ins.insertedId;

    res.json({ data: { product: doc } });
  } catch (err) {
    console.error("POST /api/admin/products error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to create product" } });
  }
});

// PATCH /api/admin/products/:id
adminRouter.patch("/products/:id", requireRole(ROLES.ADMIN, ROLES.MANAGER), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid product id" } });

    const b = req.body || {};
    const now = new Date();
    const update = { updatedAt: now };

    if (typeof b.name === "string") update.name = b.name.trim();
    if (typeof b.slug === "string") update.slug = b.slug.trim();
    if (typeof b.brand === "string") update.brand = b.brand.trim();
    if (typeof b.categorySlug === "string") update.categorySlug = b.categorySlug.trim();
    if (typeof b.image === "string") update.image = b.image.trim();

    if (b.price != null) update.price = Number(b.price);
    if (b.oldPrice != null) update.oldPrice = b.oldPrice === "" ? null : Number(b.oldPrice);
    if (typeof b.inStock === "boolean") update.inStock = b.inStock;
    if (typeof b.isActive === "boolean") update.isActive = b.isActive;

    if (Array.isArray(b.images)) update.images = b.images.map(String);
    if (Array.isArray(b.tags)) update.tags = b.tags.map(String);

    const upd = await productsCollection.findOneAndUpdate(
      { _id: toObjectId(id) },
      { $set: update },
      { returnDocument: "after" }
    );

    if (!upd.value) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Product not found" } });

    res.json({ data: { product: upd.value } });
  } catch (err) {
    console.error("PATCH /api/admin/products/:id error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to update product" } });
  }
});

// DELETE /api/admin/products/:id   ✅ this fixes your DELETE 404
adminRouter.delete("/products/:id", requireRole(ROLES.ADMIN, ROLES.MANAGER), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid product id" } });

    const now = new Date();

    const upd = await productsCollection.findOneAndUpdate(
      { _id: toObjectId(id) },
      { $set: { isActive: false, updatedAt: now } },
      { returnDocument: "after" }
    );

    if (!upd.value) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Product not found" } });

    res.json({ data: { ok: true } });
  } catch (err) {
    console.error("DELETE /api/admin/products/:id error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to delete product" } });
  }
});

// GET /api/admin/users
adminRouter.get("/users", requireRole(ROLES.ADMIN, ROLES.MANAGER), async (req, res) => {
  try {
    const { q = "", role = "", status = "", page = "1", limit = "20" } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const filter = {};
    if (role) filter.role = String(role);
    if (status) filter.status = String(status);

    const queryText = String(q || "").trim();
    if (queryText) {
      const rx = new RegExp(escapeRegex(queryText), "i");
      filter.$or = [{ email: rx }, { name: rx }, { firebaseUid: rx }];
    }

    const [items, total] = await Promise.all([
      usersCollection
        .find(filter)
        .project({ email: 1, name: 1, role: 1, status: 1, avatar: 1, firebaseUid: 1, createdAt: 1, lastLoginAt: 1 })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .toArray(),
      usersCollection.countDocuments(filter),
    ]);

    res.json({ data: { users: items, pagination: { total, page: pageNum, pages: Math.max(Math.ceil(total / limitNum), 1), limit: limitNum } } });
  } catch (err) {
    console.error("GET /api/admin/users error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load users" } });
  }
});

// PATCH /api/admin/users/:id   ✅ this fixes your PATCH users 404
adminRouter.patch("/users/:id", mustBeAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid user id" } });

    const b = req.body || {};
    const now = new Date();

    const update = { updatedAt: now };
    if (typeof b.role === "string") update.role = b.role.trim();
    if (typeof b.status === "string") update.status = b.status.trim();

    const upd = await usersCollection.findOneAndUpdate(
      { _id: toObjectId(id) },
      { $set: update },
      { returnDocument: "after" }
    );

    if (!upd.value) return res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found" } });

    res.json({ data: { user: upd.value } });
  } catch (err) {
    console.error("PATCH /api/admin/users/:id error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to update user" } });
  }
});


// ✅ ADMIN ONLY: change user STATUS
// PATCH /api/admin/users/:id/status
adminRouter.patch("/users/:id/status", mustBeAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid user id" } });

    const status = String(req.body?.status || "").trim();
    const allowed = new Set(["active", "disabled"]);
    if (!allowed.has(status)) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid status" } });

    const now = new Date();
    const upd = await usersCollection.findOneAndUpdate(
      { _id: toObjectId(id) },
      { $set: { status, updatedAt: now } },
      { returnDocument: "after" }
    );

    if (!upd.value) return res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found" } });

    res.json({ data: { user: upd.value } });
  } catch (err) {
    console.error("PATCH /api/admin/users/:id/status error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to update user status" } });
  }
});

// ✅ REMOVE or LOCK your old PATCH /users/:id endpoint
// If you keep it, DO NOT allow role updates here.
adminRouter.patch("/users/:id", mustBeAdmin, async (req, res) => {
  return res.status(410).json({
    error: {
      code: "GONE",
      message: "Use /api/admin/users/:id/role or /api/admin/users/:id/status instead",
    },
  });
});

// ✅ Mount once
app.use("/api/admin", adminRouter);


// ------------------- GEO (Reverse Geocode) -------------------
app.get("/api/geo/reverse", requireAuth, async (req, res) => {
  try {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) {
      return res.status(500).json({
        error: { code: "MISSING_KEY", message: "GOOGLE_MAPS_API_KEY not set" },
      });
    }

    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({
        error: { code: "BAD_REQUEST", message: "lat and lng are required numbers" },
      });
    }

    const url =
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}`;

    const r = await fetch(url);
    const j = await r.json();

    if (j.status !== "OK" || !Array.isArray(j.results) || !j.results[0]) {
      return res.json({ data: { ok: false, status: j.status, result: null } });
    }

    const top = j.results[0];
    const comps = top.address_components || [];

    const pick = (type) =>
      comps.find((c) => Array.isArray(c.types) && c.types.includes(type))?.long_name || "";

    const out = {
      ok: true,
      formattedAddress: top.formatted_address || "",
      placeId: top.place_id || "",
      houseNo: pick("street_number"),
      road: pick("route"),
      area:
        pick("sublocality") ||
        pick("sublocality_level_1") ||
        pick("neighborhood") ||
        pick("administrative_area_level_3") ||
        "",
      city: pick("locality") || pick("administrative_area_level_2") || "",
      zip: pick("postal_code"),
      location: { lat, lng },
    };

    return res.json({ data: out });
  } catch (err) {
    console.error("GET /api/geo/reverse error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Reverse geocode failed" },
    });
  }
});

// ------------------- USER ADDRESSES -------------------
// Stored inside user document: users.addresses = [{ id, label, ... , location }]
app.get("/api/users/me/addresses", requireAuth, async (req, res) => {
  const u = await usersCollection.findOne(
    { _id: new ObjectId(req.user._id) },
    { projection: { addresses: 1 } }
  );
  return res.json({ data: { addresses: u?.addresses || [] } });
});

app.post("/api/users/me/addresses", requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const now = new Date();

    const address = {
      id: crypto.randomBytes(8).toString("hex"),
      label: String(b.label || "Home").trim(), // Home/Work/Other
      fullName: String(b.fullName || "").trim(),
      phone: String(b.phone || "").trim(),

      city: String(b.city || "").trim(),
      area: String(b.area || "").trim(),
      line1: String(b.line1 || "").trim(), // Road/Street or full line
      houseNo: String(b.houseNo || "").trim(),
      floorNo: String(b.floorNo || "").trim(),
      block: String(b.block || "").trim(),
      flatNo: String(b.flatNo || "").trim(),
      zip: String(b.zip || "").trim(),

      notes: String(b.notes || "").trim(),
      placeId: String(b.placeId || "").trim(),
      formattedAddress: String(b.formattedAddress || "").trim(),

      location: b.location && typeof b.location === "object"
        ? { lat: Number(b.location.lat), lng: Number(b.location.lng) }
        : null,

      createdAt: now,
      updatedAt: now,
    };

    // basic validation
    if (!address.fullName || !address.phone) {
      return res.status(400).json({
        error: { code: "BAD_REQUEST", message: "fullName and phone are required" },
      });
    }
    if (!address.city || !address.area) {
      return res.status(400).json({
        error: { code: "BAD_REQUEST", message: "city and area are required" },
      });
    }
    if (!address.line1 && !address.formattedAddress) {
      return res.status(400).json({
        error: { code: "BAD_REQUEST", message: "line1 (Road/Street) is required" },
      });
    }

    await usersCollection.updateOne(
      { _id: new ObjectId(req.user._id) },
      { $push: { addresses: address }, $set: { updatedAt: now } }
    );

    return res.json({ data: { address } });
  } catch (err) {
    console.error("POST /api/users/me/addresses error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to save address" },
    });
  }
});

app.patch("/api/users/me/addresses/:addressId", requireAuth, async (req, res) => {
  try {
    const addressId = String(req.params.addressId || "");
    const b = req.body || {};
    const now = new Date();

    const update = {};
    const fields = [
      "label", "fullName", "phone", "city", "area", "line1", "houseNo", "floorNo",
      "block", "flatNo", "zip", "notes", "placeId", "formattedAddress"
    ];
    for (const f of fields) {
      if (typeof b[f] === "string") update[`addresses.$.${f}`] = b[f].trim();
    }
    if (b.location && typeof b.location === "object") {
      update["addresses.$.location"] = { lat: Number(b.location.lat), lng: Number(b.location.lng) };
    }
    update["addresses.$.updatedAt"] = now;

    const result = await usersCollection.findOneAndUpdate(
      { _id: new ObjectId(req.user._id), "addresses.id": addressId },
      { $set: update, $setOnInsert: {} },
      { returnDocument: "after" }
    );

    if (!result.value) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Address not found" } });
    }

    const addr = (result.value.addresses || []).find((a) => a.id === addressId) || null;
    return res.json({ data: { address: addr } });
  } catch (err) {
    console.error("PATCH /api/users/me/addresses/:addressId error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to update address" },
    });
  }
});

app.delete("/api/users/me/addresses/:addressId", requireAuth, async (req, res) => {
  try {
    const addressId = String(req.params.addressId || "");
    const now = new Date();

    await usersCollection.updateOne(
      { _id: new ObjectId(req.user._id) },
      { $pull: { addresses: { id: addressId } }, $set: { updatedAt: now } }
    );

    return res.json({ data: { ok: true } });
  } catch (err) {
    console.error("DELETE /api/users/me/addresses/:addressId error:", err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to delete address" },
    });
  }
});




if (process.env.NODE_ENV !== "production") {
  app.post("/api/dev/seed-chat", requireAuth, requireRole("admin", "manager"), async (req, res) => {
    const now = new Date();

    // pick any customer user
    const customer = await usersCollection.findOne({ role: "customer" });
    if (!customer) return res.status(400).json({ error: { message: "No customer user found" } });

    const conv = {
      participants: [String(req.user._id), String(customer._id)],
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      lastMessage: "Hello from admin",
      unreadBy: { [String(customer._id)]: 1 },
    };

    const cIns = await conversationsCollection.insertOne(conv);

    const msg = {
      conversationId: String(cIns.insertedId),
      senderId: String(req.user._id),
      text: "Hello from admin 👋",
      imageUrl: null,
      type: "text" | "image" | "file" | "audio",
      fileUrl: "",           // for file/audio/image
      fileName: "",          // optional
      mime: "",              // optional
      size: 0,               // optional
      duration: 0,           // for audio (seconds)
      createdAt: now,
    };

    await messagesCollection.insertOne(msg);

    res.json({ data: { conversationId: String(cIns.insertedId) } });
  });
}





// ------------------- SOCKET.IO SETUP for deploying  -------------------
// ------------------- Socket.IO -------------------
// AFTER app.use(cors...), app.use(cookieParser()), routes, etc.

let server = null;
let io = null;

// ✅ globals assigned after DB connects (keep these OUTSIDE so REST can still use them)
let conversationsCollection;
let messagesCollection;

if (!isVercel) {
  server = http.createServer(app);

  io = new Server(server, {
    cors: { origin: allowedOrigins, credentials: true },
  });

  app.locals.io = io;

  function parseCookies(cookieHeader = "") {
    return cookieHeader
      .split(";")
      .map((v) => v.trim())
      .filter(Boolean)
      .reduce((acc, part) => {
        const idx = part.indexOf("=");
        if (idx === -1) return acc;
        const k = decodeURIComponent(part.slice(0, idx).trim());
        const val = decodeURIComponent(part.slice(idx + 1).trim());
        acc[k] = val;
        return acc;
      }, {});
  }

  // ✅ auth via accessToken cookie
  io.use((socket, next) => {
    try {
      //sould be commented if it use in socket-server server.js 
      //If your socket server is on a different domain (Render) than your API (Vercel), the cookie accessToken set by the API will not be sent to the socket server (cross-domain). So this will fail:
      //So yes: remove/replace those lines in the Socket.IO server.
      // but running in loacalhost you should keep it for testing with cookie auth.
      //?
      const cookies = parseCookies(socket.handshake.headers?.cookie || "");
      const token = cookies.accessToken;
      //?
      if (!token) return next(new Error("NO_TOKEN"));

      const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
      const userId = String(payload.userId || "");
      const role = String(payload.role || "");
      if (!userId) return next(new Error("BAD_TOKEN_PAYLOAD"));

      socket.user = { userId, role, _id: userId };
      next();
    } catch {
      next(new Error("BAD_TOKEN"));
    }
  });

  io.on("connection", (socket) => {
    // console.log("✅ socket connected:", socket.id, socket.user);
    // after deploying , uncomment it

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
        // console.log("✅ joined room", `conv:${id}`, "by", myId);
        // after deploying , uncomment it
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
} else {
  // On Vercel: no websocket server
  app.locals.io = null;
}


// --- OpenAI client ---
// const OpenAI = require("openai");
// const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// POST /api/ai/proofread
// Body: { text: string, tone?: "friendly"|"professional"|"casual" }
// app.post("/api/ai/proofread", requireAuth, async (req, res) => {
//   try {
//     const text = String(req.body?.text ?? "");
//     const tone = String(req.body?.tone ?? "").toLowerCase();

//     if (!text.trim()) {
//       return res.status(400).json({ error: { message: "text is required" } });
//     }
//     if (text.length > 5000) {
//       return res.status(400).json({ error: { message: "Max 5000 characters" } });
//     }

//     const toneHint =
//       tone === "friendly" ? "Friendly, warm, but not informal." :
//       tone === "professional" ? "Professional, clear, and concise." :
//       tone === "casual" ? "Casual, natural, and simple." :
//       "Keep the original tone.";

//     const instructions = [
//       "You are a proofreading assistant.",
//       "Fix spelling, grammar, punctuation, and awkward phrasing.",
//       "Do NOT change the meaning or add new information.",
//       "Preserve formatting (line breaks, bullets, emojis).",
//       `Tone: ${toneHint}`,
//       "Return ONLY the corrected text, no quotes, no explanations."
//     ].join("\n");

//     const response = await openai.responses.create({
//       model: process.env.OPENAI_MODEL || "gpt-4o-mini" || "gpt-4o",
//       instructions,
//       input: text,
//       max_output_tokens: 1200
//     });

//     return res.json({ data: { corrected: response.output_text } });
//     // console.log("AI proofread success:", { input: text, corrected: response.output_text });
//   } catch (err) {
//   const status = err?.status || err?.response?.status;
//   const msg = err?.message || "AI proofread failed";

//   if (status === 429) {
//     return res.status(503).json({
//       error: { message: "AI is temporarily unavailable. Please try again later." }
//     });
//   }

//   return res.status(500).json({ error: { message: msg } });
// }

// });


const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ✅ AI Proofread (Gemini)
app.post("/api/ai/proofread", requireAuth, async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    const tone = String(req.body?.tone || "friendly").trim().toLowerCase();

    if (!text) {
      return res.status(400).json({ error: { message: "text is required" } });
    }
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: { message: "Missing GEMINI_API_KEY" } });
    }

    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash"; // docs example model format :contentReference[oaicite:2]{index=2}

    const toneHint =
      tone === "professional"
        ? "Professional, clear, polite."
        : tone === "casual"
        ? "Casual, friendly, simple."
        : "Friendly, warm, helpful.";

    const prompt = [
      "You are a strict proofreading assistant.",
      "Fix spelling, grammar, punctuation, and clarity WITHOUT changing meaning.",
      `Tone: ${toneHint}`,
      "Return ONLY the corrected text. No markdown, no explanations.",
      "",
      "TEXT:",
      text,
    ].join("\n");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY, // required header :contentReference[oaicite:3]{index=3}
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 400,
        },
      }),
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      const msg =
        data?.error?.message ||
        data?.message ||
        `Gemini request failed (${r.status})`;
      return res.status(500).json({ error: { message: msg } });
    }

    const corrected =
      (data?.candidates?.[0]?.content?.parts || [])
        .map((p) => p?.text || "")
        .join("")
        .trim();

    if (!corrected) {
      return res.status(500).json({
        error: { message: "Gemini returned empty output (maybe blocked or failed)." },
        debug: { hasCandidates: !!data?.candidates?.length },
      });
    }

    return res.json({ data: { corrected } });
  } catch (err) {
    console.error("Gemini proofread error:", err);
    return res.status(500).json({ error: { message: "AI proofread failed" } });
  }
});



// ------------------- Socket.IO -------------------
// AFTER app.use(cors...), app.use(cookieParser()), routes, etc.

// const server = http.createServer(app);

// const io = new Server(server, {
//   cors: { origin: allowedOrigins, credentials: true },
// });

// app.locals.io = io;

// ✅ globals assigned after DB connects
// let conversationsCollection;
// let messagesCollection;

// function parseCookies(cookieHeader = "") {
//   return cookieHeader
//     .split(";")
//     .map((v) => v.trim())
//     .filter(Boolean)
//     .reduce((acc, part) => {
//       const idx = part.indexOf("=");
//       if (idx === -1) return acc;
//       const k = decodeURIComponent(part.slice(0, idx).trim());
//       const val = decodeURIComponent(part.slice(idx + 1).trim());
//       acc[k] = val;
//       return acc;
//     }, {});
// }

// ✅ auth via accessToken cookie
// io.use((socket, next) => {
//   try {
//     const cookies = parseCookies(socket.handshake.headers?.cookie || "");
//     const token = cookies.accessToken;
//     if (!token) return next(new Error("NO_TOKEN"));

//     const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
//     const userId = String(payload.userId || "");
//     const role = String(payload.role || "");
//     if (!userId) return next(new Error("BAD_TOKEN_PAYLOAD"));

//     socket.user = { userId, role, _id: userId };
//     next();
//   } catch (e) {
//     next(new Error("BAD_TOKEN"));
//   }
// });

// io.on("connection", (socket) => {
//   console.log("✅ socket connected:", socket.id, socket.user);

//   const myId = String(socket.user.userId);
//   const role = String(socket.user.role);

//   // ✅ join role rooms
//   if (["admin", "manager"].includes(role)) socket.join("admins");
//   else socket.join("customers");

//   // ✅ mark online
//   setOnline(myId, role, socket.id);

//   // ✅ admins should see customer online/offline
//   io.to("admins").emit("presence:update", { userId: myId, online: true, role });

//   // ✅ customers should see support online/offline
//   const supportOnline = adminOnlineCount() > 0;
//   // send to the just-connected socket
//   socket.emit("support:presence", { online: supportOnline, admins: adminOnlineCount() });
//   // broadcast to all customers if admin status might have changed
//   io.to("customers").emit("support:presence", { online: supportOnline, admins: adminOnlineCount() });


//   socket.on("conversation:join", async ({ conversationId }) => {
//     try {
//       const id = String(conversationId || "");
//       if (!ObjectId.isValid(id)) return;

//       if (!conversationsCollection) return;

//       const conv = await conversationsCollection.findOne({ _id: new ObjectId(id) });
//       if (!conv) return;

//       const participants = (conv.participants || []).map(String);
//       const isAdmin = ["admin", "manager"].includes(role);
//       if (!isAdmin && !participants.includes(myId)) return;

//       socket.join(`conv:${id}`);
//       console.log("✅ joined room", `conv:${id}`, "by", myId);
//     } catch (err) {
//       console.error("conversation:join error:", err);
//     }
//   });

//   socket.on("message:send", async (payload, ack) => {
//     const safeAck = (obj) => {
//       try {
//         if (typeof ack === "function") ack(obj);
//       } catch { }
//     };

//     try {
//       if (!conversationsCollection || !messagesCollection) {
//         return safeAck({ ok: false, error: "DB_NOT_READY" });
//       }

//       const conversationId = String(payload?.conversationId || "");
//       const tempId = String(payload?.tempId || "");

//       // ✅ FIX: text must exist
//       const text = String(payload?.text ?? "").trim();

//       // backwards compat (older clients send imageUrl only)
//       const imageUrl = String(payload?.imageUrl ?? "").trim();
//       const fileUrl = String(payload?.fileUrl ?? "").trim() || imageUrl;

//       const fileName = String(payload?.fileName ?? "").trim();
//       const mime = String(payload?.mime ?? "").trim();
//       const size = Number.isFinite(Number(payload?.size)) ? Number(payload.size) : 0;
//       const duration = Number.isFinite(Number(payload?.duration)) ? Number(payload.duration) : 0;

//       // ✅ infer type if missing
//       let type = String(payload?.type || "").trim().toLowerCase();
//       if (!type) {
//         if (!fileUrl) type = "text";
//         else if (mime.startsWith("audio/")) type = "audio";
//         else if (mime.startsWith("image/") || imageUrl) type = "image";
//         else type = "file";
//       }

//       const allowedTypes = new Set(["text", "image", "file", "audio"]);
//       if (!allowedTypes.has(type)) return safeAck({ ok: false, error: "BAD_TYPE", tempId });

//       if (!ObjectId.isValid(conversationId)) {
//         return safeAck({ ok: false, error: "BAD_CONVERSATION_ID", tempId });
//       }

//       // ✅ correct validation
//       if (type === "text" && !text) {
//         return safeAck({ ok: false, error: "EMPTY_TEXT", tempId });
//       }
//       if (type !== "text" && !fileUrl) {
//         return safeAck({ ok: false, error: "MISSING_FILE_URL", tempId });
//       }

//       const conv = await conversationsCollection.findOne({ _id: new ObjectId(conversationId) });
//       if (!conv) return safeAck({ ok: false, error: "CONVERSATION_NOT_FOUND", tempId });

//       const participants = (conv.participants || []).map(String);
//       const isAdmin = ["admin", "manager"].includes(String(role || ""));
//       if (!isAdmin && !participants.includes(String(myId))) {
//         return safeAck({ ok: false, error: "NOT_ALLOWED", tempId });
//       }

//       const now = new Date();

//       // ✅ store unified fields (+ keep imageUrl for old UIs)
//       const msg = {
//         conversationId,
//         senderId: String(myId),
//         type,
//         text: type === "text" ? text : "",
//         fileUrl: type === "text" ? "" : fileUrl,
//         imageUrl: type === "image" ? fileUrl : null, // backward compatibility
//         fileName: type === "text" ? "" : fileName,
//         mime: type === "text" ? "" : mime,
//         size: type === "text" ? 0 : size,
//         duration: type === "audio" ? duration : 0,
//         createdAt: now,
//       };

//       const ins = await messagesCollection.insertOne(msg);
//       msg._id = String(ins.insertedId);

//       const preview =
//         type === "image" ? "[image]" :
//           type === "audio" ? "[voice]" :
//             type === "file" ? "[file]" :
//               (text.slice(0, 120) || "");

//       await conversationsCollection.updateOne(
//         { _id: new ObjectId(conversationId) },
//         {
//           $set: {
//             updatedAt: now,
//             lastMessageAt: now,
//             lastMessage: preview,
//           },
//         }
//       );

//       // ✅ send to others in the room; sender updates via ACK
//       socket.to(`conv:${conversationId}`).emit("message:new", { message: msg });

//       return safeAck({ ok: true, message: msg, tempId });
//     } catch (err) {
//       console.error("message:send error:", err?.stack || err);
//       return safeAck({ ok: false, error: "SERVER_ERROR", detail: String(err?.message || err) });
//     }
//   });


//   socket.on("disconnect", () => {
//     setOffline(myId, socket.id);

//     // only broadcast offline if user fully disconnected (no more sockets)
//     if (!isUserOnline(myId)) {
//       io.to("admins").emit("presence:update", { userId: myId, online: false, role });
//     }

//     // support status may change if an admin disconnected
//     if (["admin", "manager"].includes(role)) {
//       io.to("customers").emit("support:presence", {
//         online: adminOnlineCount() > 0,
//         admins: adminOnlineCount(),
//       });
//     }
//   });



// });


// ✅ CUSTOMER CHAT ROUTER
// ✅ CUSTOMER CHAT ROUTER
const customerChatRouter = express.Router();
customerChatRouter.use(requireAuth);

// GET /api/chat/bootstrap
customerChatRouter.get("/bootstrap", async (req, res) => {
  try {
    const myId = String(req.user._id); // ✅ always Mongo user id as string

    // 1) find existing conversation
    let conv = await conversationsCollection.findOne({ customerId: myId });

    // 2) create if none
    if (!conv) {
      const now = new Date();
      const doc = {
        customerId: myId,
        participants: [myId], // ✅ stored as string ids
        createdAt: now,
        updatedAt: now,
        lastMessage: "",
        lastMessageAt: null,
      };
      const ins = await conversationsCollection.insertOne(doc);
      conv = { ...doc, _id: ins.insertedId };
    }

    // 3) load last 50 messages (latest 50, in correct order)
    const rows = await messagesCollection
      .find({ conversationId: String(conv._id) })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    const messages = rows.reverse().map((m) => ({ ...m, _id: String(m._id) }));

    res.json({
      data: {
        conversationId: String(conv._id),
        me: { id: myId, name: req.user.name || "", email: req.user.email || "" },
        messages,
      },
    });
  } catch (err) {
    console.error("GET /api/chat/bootstrap error:", err);
    res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to bootstrap chat" },
    });
  }
});

app.use("/api/chat", customerChatRouter);


customerChatRouter.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: { message: "file is required" } });
    }

    // ✅ allowlist (adjust as you want)
    const mime = String(req.file.mimetype || "");
    const allowed =
      mime.startsWith("image/") ||
      mime.startsWith("audio/") ||
      mime === "application/pdf";

    if (!allowed) {
      return res.status(400).json({
        error: { message: `File type not allowed: ${mime}` },
      });
    }

    // ✅ Upload to Cloudinary/S3/etc.
    // You already have Cloudinary in your admin upload route.
    // Reuse the SAME upload function you already use there.

    // Example: pretend we got an url back
    const url = await uploadBufferToCloudinary(req.file.buffer, {
      folder: "thomview/chat",
      mime,
      filename: req.file.originalname,
    });

    return res.json({
      data: {
        url,
        originalName: req.file.originalname,
        mime,
        size: req.file.size,
      },
    });
  } catch (err) {
    console.error("POST /api/chat/upload error:", err);
    res.status(500).json({ error: { message: "Upload failed" } });
  }
});

app.use("/api/uploads", customerUploadRouter);





// let dbInitPromise;

// async function initDbOnce() {
//   if (!dbInitPromise) {
//     dbInitPromise = (async () => {
//       await client.connect();
//       console.log("✅ Connected to MongoDB");
//       db = client.db(process.env.DB_NAME || "thomview");

//       usersCollection = db.collection("users");
//       homeMosaicsCollection = db.collection("home_mosaics");
//       productsCollection = db.collection("products");
//       ordersCollection = db.collection("orders"); // ✅
//       homeBrandBannersCollection = db.collection("home_brand_banners");
//       homeBigDealsCollection = db.collection("home_big_deals");
//       homeProductRailsCollection = db.collection("home_product_rails");
//       homeHeroWithRailCollection = db.collection("home_hero_with_rail");
//       homeRailWithBannerCollection = db.collection("home_rail_with_banner");
//       homeDepartmentsCollection = db.collection("home_departments");
//       homeRailSectionsCollection = db.collection("home_rail_sections");
//       conversationsCollection = db.collection("chat_conversations");
//       messagesCollection = db.collection("chat_messages");

//       // after db + collections are created
//       app.locals.usersCollection = usersCollection;
//       // create these (if you don't already)
//       app.locals.conversationsCollection = conversationsCollection;
//       app.locals.messagesCollection = messagesCollection;

//       // (optional) indexes
//       // keep createIndex, avoid dropIndex on serverless if possible
//       console.log("✅ DB ready");
//     })();
//   }
//   return dbInitPromise;
// }

// ✅ ensure DB is ready before any route uses collections
// app.use(async (req, res, next) => {
//   try {
//     await initDbOnce();
//     next();
//   } catch (err) {
//     console.error("DB init failed:", err);
//     res.status(500).json({ error: { message: "DB connection failed" } });
//   }
// });


// ------------------- Start -------------------
// async function run() {
//   try {
//     // await client.connect();
//     // console.log("✅ Connected to MongoDB");

//     db = client.db(process.env.DB_NAME || "thomview"); // ✅ global assignment


//     usersCollection = db.collection("users");
//     homeMosaicsCollection = db.collection("home_mosaics");
//     productsCollection = db.collection("products");
//     ordersCollection = db.collection("orders"); // ✅
//     homeBrandBannersCollection = db.collection("home_brand_banners");
//     homeBigDealsCollection = db.collection("home_big_deals");
//     homeProductRailsCollection = db.collection("home_product_rails");
//     homeHeroWithRailCollection = db.collection("home_hero_with_rail");
//     homeRailWithBannerCollection = db.collection("home_rail_with_banner");
//     homeDepartmentsCollection = db.collection("home_departments");
//     homeRailSectionsCollection = db.collection("home_rail_sections");
//     conversationsCollection = db.collection("chat_conversations");
//     messagesCollection = db.collection("chat_messages");





//     // after db + collections are created
//     app.locals.usersCollection = usersCollection;
//     // create these (if you don't already)
//     app.locals.conversationsCollection = conversationsCollection;
//     app.locals.messagesCollection = messagesCollection;




//     // ✅ Indexes (safe)
//     await safeCreateIndex(usersCollection, { firebaseUid: 1 }, { unique: true });
//     await safeCreateIndex(usersCollection, { email: 1 }, { unique: true });
//     await safeCreateIndex(homeMosaicsCollection, { slug: 1 }, { unique: true });
//     await safeCreateIndex(homeBrandBannersCollection, { slug: 1 }, { unique: true });
//     await safeCreateIndex(homeBigDealsCollection, { slug: 1 }, { unique: true });
//     await safeCreateIndex(homeProductRailsCollection, { slug: 1 }, { unique: true });
//     await safeCreateIndex(homeHeroWithRailCollection, { slug: 1, key: 1 }, { unique: true });
//     await safeCreateIndex(homeRailWithBannerCollection, { slug: 1, key: 1 }, { unique: true });
//     await safeCreateIndex(homeDepartmentsCollection, { slug: 1 }, { unique: true });
//     await safeCreateIndex(homeRailSectionsCollection, { slug: 1, key: 1 }, { unique: true });
//     await safeCreateIndex(productsCollection, { categorySlug: 1 });
//     await safeCreateIndex(productsCollection, { price: 1 });
//     await safeCreateIndex(productsCollection, { brand: 1 });
//     await safeCreateIndex(productsCollection, { tags: 1 });
//     await safeCreateIndex(productsCollection, { inStock: 1 });
//     await safeCreateIndex(productsCollection, { createdAt: -1 });
//     await safeCreateIndex(productsCollection, { name: "text", brand: "text" }, { name: "name_text_brand_text" });
//     await safeCreateIndex(
//       homeProductRailsCollection,
//       { slug: 1, key: 1 },
//       { unique: true, name: "slug_1_key_1" }
//     );
//     await safeCreateIndex(
//       ordersCollection,
//       { orderNumber: 1 },
//       {
//         unique: true,
//         name: "orderNumber_1", // keep the name consistent
//         partialFilterExpression: { orderNumber: { $type: "string" } },
//       }
//     );

//     await safeCreateIndex(ordersCollection, { createdAt: -1 });
//     await safeCreateIndex(ordersCollection, { userId: 1, createdAt: -1 });

//     await safeCreateIndex(ordersCollection, { status: 1, createdAt: -1 });
//     await safeCreateIndex(ordersCollection, { "payment.status": 1, createdAt: -1 });


//     // ✅ allow multiple rails per slug by using compound unique index
//     //     That error happens because your collection home_product_rails has a UNIQUE index on slug only:

//     // index: slug_1 dup key: { slug: "home" }

//     // So MongoDB is allowing only ONE document per slug.
//     // You already have a document with slug: "home" (your screenshot shows it with key: "top-picks"), so inserting another doc with slug: "home" (even with a different key) gets blocked.

//     // ✅ Fix (recommended): change the index to { slug, key } unique

//     // This will let you store multiple rails for the same home page, like:

//     // home + top-picks

//     // home + baby-musts
//     try {
//       await homeProductRailsCollection.dropIndex("slug_1");
//       console.log("🧹 Dropped old unique index: slug_1 (home_product_rails)");
//     } catch (e) {
//       // ignore if index doesn't exist
//     }

//     // ✅ IMPORTANT: If you previously created a unique index on orderNumber,
//     // it may still block inserts when orderNumber is null.
//     // Drop the old index if it exists, then create the partial unique index.
//     try {
//       await ordersCollection.dropIndex("orderNumber_1");
//       console.log("🧹 Dropped old index: orderNumber_1");
//     } catch (e) {
//       // ignore if index doesn't exist
//     }

//     // ✅ Try enabling text search (optional; safe)
//     try {
//       await productsCollection.createIndex(
//         { name: "text", brand: "text" },
//         { name: "name_text_brand_text" }
//       );
//       supportsTextSearch = true;
//       console.log("✅ Text search index ready (supports $text search).");
//     } catch (err) {
//       supportsTextSearch = false;
//       console.warn("⚠️ Text search not available; using regex fallback:", err?.message || err);
//     }



//     // ✅ IMPORTANT: start server here (not app.listen)
//     // server.listen(port, () => {
//     //   console.log(`✅ Server listening at http://localhost:${port}`);
//     //   console.log(`✅ CORS origins: ${allowedOrigins.join(", ")}`);
//     // });
//     if (!isVercel && server) {
//       server.listen(port, () => {
//         console.log(`✅ Server listening at http://localhost:${port}`);
//         console.log(`✅ CORS origins: ${allowedOrigins.join(", ")}`);

//       });
//     }



//   } catch (err) {
//     console.error("run() error:", err);
//     process.exit(1);
//   }
// }

// run();

// ------------------- DB init (Vercel-safe) -------------------
const AUTO_INDEX = process.env.AUTO_INDEX === "true";          // optional
const RUN_MIGRATIONS = process.env.RUN_MIGRATIONS === "true";  // optional (use carefully)

let dbInitPromise = null;

async function initDbOnce() {
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      // await client.connect(); 
      // ✅ IMPORTANT: connect here (don’t keep it commented)
      db = client.db(process.env.DB_NAME || "thomview");

      usersCollection = db.collection("users");
      homeMosaicsCollection = db.collection("home_mosaics");
      productsCollection = db.collection("products");
      ordersCollection = db.collection("orders");

      homeBrandBannersCollection = db.collection("home_brand_banners");
      homeBigDealsCollection = db.collection("home_big_deals");
      homeProductRailsCollection = db.collection("home_product_rails");
      homeHeroWithRailCollection = db.collection("home_hero_with_rail");
      homeRailWithBannerCollection = db.collection("home_rail_with_banner");
      homeDepartmentsCollection = db.collection("home_departments");
      homeRailSectionsCollection = db.collection("home_rail_sections");

      conversationsCollection = db.collection("chat_conversations");
      messagesCollection = db.collection("chat_messages");

      // locals (optional but fine)
      app.locals.usersCollection = usersCollection;
      app.locals.conversationsCollection = conversationsCollection;
      app.locals.messagesCollection = messagesCollection;

      // ✅ Indexes: safe to create (optional; controlled by env)
      if (AUTO_INDEX) {
        await safeCreateIndex(usersCollection, { firebaseUid: 1 }, { unique: true });
        await safeCreateIndex(usersCollection, { email: 1 }, { unique: true });

        await safeCreateIndex(homeMosaicsCollection, { slug: 1 }, { unique: true });
        await safeCreateIndex(homeBrandBannersCollection, { slug: 1 }, { unique: true });
        await safeCreateIndex(homeBigDealsCollection, { slug: 1 }, { unique: true });

        // IMPORTANT: make rails unique by (slug, key)
        await safeCreateIndex(homeProductRailsCollection, { slug: 1, key: 1 }, { unique: true, name: "slug_1_key_1" });

        await safeCreateIndex(homeHeroWithRailCollection, { slug: 1, key: 1 }, { unique: true });
        await safeCreateIndex(homeRailWithBannerCollection, { slug: 1, key: 1 }, { unique: true });
        await safeCreateIndex(homeDepartmentsCollection, { slug: 1 }, { unique: true });
        await safeCreateIndex(homeRailSectionsCollection, { slug: 1, key: 1 }, { unique: true });

        await safeCreateIndex(productsCollection, { categorySlug: 1 });
        await safeCreateIndex(productsCollection, { price: 1 });
        await safeCreateIndex(productsCollection, { brand: 1 });
        await safeCreateIndex(productsCollection, { tags: 1 });
        await safeCreateIndex(productsCollection, { inStock: 1 });
        await safeCreateIndex(productsCollection, { createdAt: -1 });

        // text search (optional)
        try {
          await productsCollection.createIndex(
            { name: "text", brand: "text" },
            { name: "name_text_brand_text" }
          );
          supportsTextSearch = true;
        } catch (err) {
          supportsTextSearch = false;
        }

        // partial unique orderNumber
        await safeCreateIndex(
          ordersCollection,
          { orderNumber: 1 },
          {
            unique: true,
            name: "orderNumber_1",
            partialFilterExpression: { orderNumber: { $type: "string" } },
          }
        );

        await safeCreateIndex(ordersCollection, { createdAt: -1 });
        await safeCreateIndex(ordersCollection, { userId: 1, createdAt: -1 });
        await safeCreateIndex(ordersCollection, { status: 1, createdAt: -1 });
        await safeCreateIndex(ordersCollection, { "payment.status": 1, createdAt: -1 });
      }

      // ⚠️ Drop index migrations: don’t run on every cold start.
      // Only run when you intentionally set RUN_MIGRATIONS=true once.
      if (RUN_MIGRATIONS) {
        try { await homeProductRailsCollection.dropIndex("slug_1"); } catch {}
        try { await ordersCollection.dropIndex("orderNumber_1"); } catch {}
      }

      // console.log("✅ DB initialized");
      // after deploying , uncomment it
    })();
  }

  return dbInitPromise;
}

// ✅ Make requests wait for DB readiness (THIS is the “request-safe” part)
app.use(async (req, res, next) => {
  try {
    await initDbOnce();
    next();
  } catch (e) {
    console.error("DB init error:", e);
    res.status(500).json({ error: { message: "DB init failed" } });
  }
});

// ------------------- Export for Vercel -------------------
module.exports = app;

// ------------------- Local dev start only -------------------
if (!isVercel) {
  initDbOnce()
    .then(() => {
      if (server) {
        server.listen(port, () => console.log(`✅ Local server on http://localhost:${port}`));
      } else {
        app.listen(port, () => console.log(`✅ Local server on http://localhost:${port}`));
      }
    })
    .catch((err) => {
      console.error("❌ Failed to start:", err);
      process.exit(1);
    });
}

