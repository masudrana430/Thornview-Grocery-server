// auth/jwtAuth.js
const jwt = require("jsonwebtoken");

function requireJwtAuth(req, res, next) {
  try {
    // ✅ accept cookie OR Bearer
    const cookieToken = req.cookies?.accessToken;
    const header = req.headers.authorization || "";
    const bearerToken = header.startsWith("Bearer ") ? header.slice(7) : null;

    const token = cookieToken || bearerToken;

    if (!token) {
      return res
        .status(401)
        .json({ error: { code: "NO_TOKEN", message: "Missing token" } });
    }

    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);

    // Your login signs { userId, role } so keep consistent shape
    req.user = {
      userId: payload.userId,
      role: payload.role,
    };

    next();
  } catch (err) {
    return res
      .status(401)
      .json({ error: { code: "BAD_TOKEN", message: "Invalid token" } });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    const role = String(req.user?.role || "");
    if (!roles.includes(role)) {
      return res
        .status(403)
        .json({ error: { code: "FORBIDDEN", message: "Forbidden" } });
    }
    next();
  };
}

module.exports = { requireJwtAuth, requireRole };
