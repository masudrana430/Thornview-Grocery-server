// chat/customerUploadRouter.js
const express = require("express");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");
const { requireJwtAuth } = require("../auth/jwtAuth"); // <-- use cookie+bearer version you fixed

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

router.use(requireJwtAuth); // ✅ customer must be logged in (cookie or bearer)

// ---- IMAGE ----
router.post("/chat-image", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Missing file" } });
    }

    const b64 = req.file.buffer.toString("base64");
    const dataUri = `data:${req.file.mimetype};base64,${b64}`;

    const up = await cloudinary.uploader.upload(dataUri, {
      folder: "thomview/chat",
      resource_type: "image",
    });

    res.json({
      data: {
        url: up.secure_url,
        fileName: req.file.originalname,
        mime: req.file.mimetype,
        size: req.file.size,
      },
    });
  } catch (err) {
    console.error("customer upload image error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Upload failed" } });
  }
});

// ---- FILE (pdf/doc/zip etc) ----
router.post("/chat-file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Missing file" } });
    }

    const b64 = req.file.buffer.toString("base64");
    const dataUri = `data:${req.file.mimetype};base64,${b64}`;

    const up = await cloudinary.uploader.upload(dataUri, {
      folder: "thomview/chat",
      resource_type: "raw",
    });

    res.json({
      data: {
        url: up.secure_url,
        fileName: req.file.originalname,
        mime: req.file.mimetype,
        size: req.file.size,
      },
    });
  } catch (err) {
    console.error("customer upload file error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Upload failed" } });
  }
});

// ---- AUDIO (voice note) ----
router.post("/chat-audio", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Missing file" } });
    }

    const b64 = req.file.buffer.toString("base64");
    const dataUri = `data:${req.file.mimetype};base64,${b64}`;

    const up = await cloudinary.uploader.upload(dataUri, {
      folder: "thomview/chat",
      resource_type: "video", // ✅ Cloudinary treats audio as "video"
    });

    res.json({
      data: {
        url: up.secure_url,
        fileName: req.file.originalname,
        mime: req.file.mimetype,
        size: req.file.size,
      },
    });
  } catch (err) {
    console.error("customer upload audio error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Upload failed" } });
  }
});

module.exports = { customerUploadRouter: router };
