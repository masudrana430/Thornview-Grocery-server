// server/utils/authCookies.js
export function setAuthCookies(res, accessToken, refreshToken, isProd = false) {
  // accessToken (short-lived)
  res.cookie("accessToken", accessToken, {
    httpOnly: true,
    secure: isProd,                 // true on production (https)
    sameSite: isProd ? "none" : "lax",
    maxAge: 1000 * 60 * 60,         // 1 hour
  });

  // refreshToken (long-lived)
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
  });
}

export function clearAuthCookies(res) {
  res.clearCookie("accessToken");
  res.clearCookie("refreshToken");
}
