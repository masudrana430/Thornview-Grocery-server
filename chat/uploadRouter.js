// chat/uploadRouter.js
const express = require("express");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");
const { requireJwtAuth, requireRole } = require("../auth/jwtAuth");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB (adjust if you want)
});

const uploadRouter = express.Router();

uploadRouter.use(requireJwtAuth);
uploadRouter.use(requireRole("admin", "manager"));

// ✅ This now uploads ANY type: images, pdf, zip, audio/webm, etc.
// chat/uploadRouter.js
uploadRouter.post("/chat-asset", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Missing file" } });
    }

    const b64 = req.file.buffer.toString("base64");
    const dataUri = `data:${req.file.mimetype};base64,${b64}`;

    const up = await cloudinary.uploader.upload(dataUri, {
      folder: "thomview/chat",
      resource_type: "auto", // ✅ image / audio / pdf / zip etc.
    });

    return res.json({
      data: {
        url: up.secure_url,
        bytes: up.bytes || 0,
        mime: req.file.mimetype,
        originalName: req.file.originalname,
        resourceType: up.resource_type,
      },
    });
  } catch (err) {
    console.error("POST /api/admin/uploads/chat-asset error:", err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Upload failed" } });
  }
});


module.exports = { uploadRouter };
