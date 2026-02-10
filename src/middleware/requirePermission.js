const rolePermissions = {
  super_admin: ["*"],
  admin: ["*"],
  moderator: ["streams:view", "reports:view"],
  viewer: ["streams:view"],
};

const hasPermission = (permissionList, permission) => {
  if (!permission) return false;
  if (permissionList.includes("*")) return true;
  if (Array.isArray(permission)) {
    return permission.some((p) => permissionList.includes(p));
  }
  return permissionList.includes(permission);
};

module.exports = function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Yetkilendirme gerekli" });
    }

    const role = req.user.role || "viewer";
    const explicitPermissions = Array.isArray(req.user.permissions)
      ? req.user.permissions
      : [];

    const derivedPermissions = rolePermissions[role] || [];
    const permissionList = explicitPermissions.length
      ? explicitPermissions
      : derivedPermissions;

    if (hasPermission(permissionList, permission)) {
      return next();
    }

    return res.status(403).json({ message: "Yetki gerekli" });
  };
};
