package auth

// Role constants define the permission hierarchy.
// admin > operator > viewer > pro
const (
	RoleAdmin    = "admin"
	RoleOperator = "operator"
	RoleViewer   = "viewer"
	RolePro      = "pro" // API-only, no web panel access
)

// RoleLevel returns the numeric privilege level for a role.
// Higher = more privileges.
func RoleLevel(role string) int {
	switch role {
	case RoleAdmin:
		return 3
	case RoleOperator:
		return 2
	case RoleViewer:
		return 1
	case RolePro:
		return 0 // API-only, lowest privilege
	default:
		return 0
	}
}

// HasPermission returns true if userRole has at least the privileges of requiredRole.
func HasPermission(userRole, requiredRole string) bool {
	return RoleLevel(userRole) >= RoleLevel(requiredRole)
}

// ValidRole returns true if the given string is a recognised role.
func ValidRole(r string) bool {
	return r == RoleAdmin || r == RoleOperator || r == RoleViewer || r == RolePro
}
