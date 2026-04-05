// Organization management REST API handlers (v3.0.0).
//
// Endpoints:
//   POST   /api/org                  — create organization
//   GET    /api/org                  — list organizations
//   GET    /api/org/{id}             — get organization details
//   PUT    /api/org/{id}             — update organization
//   DELETE /api/org/{id}             — delete organization
//   GET    /api/org/{id}/users       — list org users
//   POST   /api/org/{id}/users       — add user to org
//   PUT    /api/org/{id}/users/{uid} — update user
//   DELETE /api/org/{id}/users/{uid} — remove user
//   POST   /api/org/{id}/invite      — generate invitation
//   GET    /api/org/{id}/invitations — list invitations
//   POST   /api/org/{id}/devices     — assign device to org
//   GET    /api/org/{id}/devices     — list org devices
//   DELETE /api/org/{id}/devices/{did} — unassign device
//   GET    /api/org/{id}/settings    — list org settings
//   PUT    /api/org/{id}/settings    — update org setting
//   POST   /api/org/login            — org user login (returns JWT)

package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"

	"github.com/unitronix/betterdesk-server/db"
)

var slugRegexp = regexp.MustCompile(`^[a-z0-9][a-z0-9\-]{1,62}[a-z0-9]$`)

// ---------------------------------------------------------------------------
//  Organizations
// ---------------------------------------------------------------------------

// POST /api/org
func (s *Server) handleCreateOrg(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name     string `json:"name"`
		Slug     string `json:"slug"`
		LogoURL  string `json:"logo_url"`
		Settings string `json:"settings"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	body.Slug = strings.TrimSpace(strings.ToLower(body.Slug))

	if body.Name == "" {
		http.Error(w, `{"error":"name is required"}`, http.StatusBadRequest)
		return
	}
	if !slugRegexp.MatchString(body.Slug) {
		http.Error(w, `{"error":"slug must be 3-64 lowercase alphanumeric characters with optional hyphens"}`, http.StatusBadRequest)
		return
	}

	// Check slug uniqueness
	existing, _ := s.db.GetOrganizationBySlug(body.Slug)
	if existing != nil {
		http.Error(w, `{"error":"slug already in use"}`, http.StatusConflict)
		return
	}

	if body.Settings == "" {
		body.Settings = "{}"
	}

	org := &db.Organization{
		ID:        uuid.New().String(),
		Name:      body.Name,
		Slug:      body.Slug,
		LogoURL:   body.LogoURL,
		Settings:  body.Settings,
		CreatedAt: time.Now().UTC(),
	}

	if err := s.db.CreateOrganization(org); err != nil {
		log.Printf("[org] CreateOrganization error: %v", err)
		http.Error(w, `{"error":"failed to create organization"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(org)
}

// GET /api/org
func (s *Server) handleListOrgs(w http.ResponseWriter, r *http.Request) {
	orgs, err := s.db.ListOrganizations()
	if err != nil {
		log.Printf("[org] ListOrganizations error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	if orgs == nil {
		orgs = []*db.Organization{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"organizations": orgs})
}

// GET /api/org/{id}
func (s *Server) handleGetOrg(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		http.Error(w, `{"error":"id required"}`, http.StatusBadRequest)
		return
	}

	org, err := s.db.GetOrganization(id)
	if err != nil {
		log.Printf("[org] GetOrganization error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	if org == nil {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(org)
}

// PUT /api/org/{id}
func (s *Server) handleUpdateOrg(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		http.Error(w, `{"error":"id required"}`, http.StatusBadRequest)
		return
	}

	org, err := s.db.GetOrganization(id)
	if err != nil || org == nil {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		return
	}

	var body struct {
		Name     *string `json:"name"`
		Slug     *string `json:"slug"`
		LogoURL  *string `json:"logo_url"`
		Settings *string `json:"settings"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	if body.Name != nil {
		org.Name = strings.TrimSpace(*body.Name)
	}
	if body.Slug != nil {
		slug := strings.TrimSpace(strings.ToLower(*body.Slug))
		if !slugRegexp.MatchString(slug) {
			http.Error(w, `{"error":"invalid slug"}`, http.StatusBadRequest)
			return
		}
		// Check slug uniqueness (if changed)
		if slug != org.Slug {
			existing, _ := s.db.GetOrganizationBySlug(slug)
			if existing != nil {
				http.Error(w, `{"error":"slug already in use"}`, http.StatusConflict)
				return
			}
		}
		org.Slug = slug
	}
	if body.LogoURL != nil {
		org.LogoURL = *body.LogoURL
	}
	if body.Settings != nil {
		org.Settings = *body.Settings
	}

	if err := s.db.UpdateOrganization(org); err != nil {
		log.Printf("[org] UpdateOrganization error: %v", err)
		http.Error(w, `{"error":"failed to update"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(org)
}

// DELETE /api/org/{id}
func (s *Server) handleDeleteOrg(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		http.Error(w, `{"error":"id required"}`, http.StatusBadRequest)
		return
	}

	if err := s.db.DeleteOrganization(id); err != nil {
		log.Printf("[org] DeleteOrganization error: %v", err)
		http.Error(w, `{"error":"failed to delete"}`, http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
//  Org Users
// ---------------------------------------------------------------------------

// POST /api/org/{id}/users
func (s *Server) handleCreateOrgUser(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	// Verify org exists
	org, _ := s.db.GetOrganization(orgID)
	if org == nil {
		http.Error(w, `{"error":"organization not found"}`, http.StatusNotFound)
		return
	}

	var body struct {
		Username    string `json:"username"`
		DisplayName string `json:"display_name"`
		Email       string `json:"email"`
		Password    string `json:"password"`
		Role        string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	body.Username = strings.TrimSpace(body.Username)
	if body.Username == "" || body.Password == "" {
		http.Error(w, `{"error":"username and password are required"}`, http.StatusBadRequest)
		return
	}
	if body.Role == "" {
		body.Role = db.OrgRoleUser
	}
	if body.Role != db.OrgRoleOwner && body.Role != db.OrgRoleAdmin &&
		body.Role != db.OrgRoleOperator && body.Role != db.OrgRoleUser {
		http.Error(w, `{"error":"invalid role (owner, admin, operator, user)"}`, http.StatusBadRequest)
		return
	}

	// Check duplicate
	existing, _ := s.db.GetOrgUserByUsername(orgID, body.Username)
	if existing != nil {
		http.Error(w, `{"error":"username already exists in this organization"}`, http.StatusConflict)
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
	if err != nil {
		http.Error(w, `{"error":"password hashing failed"}`, http.StatusInternalServerError)
		return
	}

	user := &db.OrgUser{
		ID:           uuid.New().String(),
		OrgID:        orgID,
		Username:     body.Username,
		DisplayName:  body.DisplayName,
		Email:        body.Email,
		PasswordHash: string(hash),
		Role:         body.Role,
		CreatedAt:    time.Now().UTC(),
	}

	if err := s.db.CreateOrgUser(user); err != nil {
		log.Printf("[org] CreateOrgUser error: %v", err)
		http.Error(w, `{"error":"failed to create user"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(user)
}

// GET /api/org/{id}/users
func (s *Server) handleListOrgUsers(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	users, err := s.db.ListOrgUsers(orgID)
	if err != nil {
		log.Printf("[org] ListOrgUsers error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	if users == nil {
		users = []*db.OrgUser{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"users": users})
}

// PUT /api/org/{id}/users/{uid}
func (s *Server) handleUpdateOrgUser(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if uid == "" {
		http.Error(w, `{"error":"user id required"}`, http.StatusBadRequest)
		return
	}

	user, err := s.db.GetOrgUser(uid)
	if err != nil || user == nil {
		http.Error(w, `{"error":"user not found"}`, http.StatusNotFound)
		return
	}

	var body struct {
		DisplayName *string `json:"display_name"`
		Email       *string `json:"email"`
		Role        *string `json:"role"`
		Password    *string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	if body.DisplayName != nil {
		user.DisplayName = *body.DisplayName
	}
	if body.Email != nil {
		user.Email = *body.Email
	}
	if body.Role != nil {
		if *body.Role != db.OrgRoleOwner && *body.Role != db.OrgRoleAdmin &&
			*body.Role != db.OrgRoleOperator && *body.Role != db.OrgRoleUser {
			http.Error(w, `{"error":"invalid role"}`, http.StatusBadRequest)
			return
		}
		user.Role = *body.Role
	}

	if err := s.db.UpdateOrgUser(user); err != nil {
		log.Printf("[org] UpdateOrgUser error: %v", err)
		http.Error(w, `{"error":"failed to update user"}`, http.StatusInternalServerError)
		return
	}

	// Handle password change separately (requires re-hashing)
	if body.Password != nil && *body.Password != "" {
		hash, err := bcrypt.GenerateFromPassword([]byte(*body.Password), bcrypt.DefaultCost)
		if err == nil {
			user.PasswordHash = string(hash)
			s.db.UpdateOrgUser(user)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(user)
}

// DELETE /api/org/{id}/users/{uid}
func (s *Server) handleDeleteOrgUser(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if uid == "" {
		http.Error(w, `{"error":"user id required"}`, http.StatusBadRequest)
		return
	}

	if err := s.db.DeleteOrgUser(uid); err != nil {
		log.Printf("[org] DeleteOrgUser error: %v", err)
		http.Error(w, `{"error":"failed to delete user"}`, http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
//  Org Devices
// ---------------------------------------------------------------------------

// POST /api/org/{id}/devices
func (s *Server) handleAssignOrgDevice(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")

	var body struct {
		DeviceID       string `json:"device_id"`
		AssignedUserID string `json:"assigned_user_id"`
		Department     string `json:"department"`
		Location       string `json:"location"`
		Building       string `json:"building"`
		Tags           string `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	if body.DeviceID == "" {
		http.Error(w, `{"error":"device_id is required"}`, http.StatusBadRequest)
		return
	}

	d := &db.OrgDevice{
		OrgID:          orgID,
		DeviceID:       body.DeviceID,
		AssignedUserID: body.AssignedUserID,
		Department:     body.Department,
		Location:       body.Location,
		Building:       body.Building,
		Tags:           body.Tags,
	}

	if err := s.db.AssignDeviceToOrg(d); err != nil {
		log.Printf("[org] AssignDeviceToOrg error: %v", err)
		http.Error(w, `{"error":"failed to assign device"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(d)
}

// GET /api/org/{id}/devices
func (s *Server) handleListOrgDevices(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	devices, err := s.db.ListOrgDevices(orgID)
	if err != nil {
		log.Printf("[org] ListOrgDevices error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	if devices == nil {
		devices = []*db.OrgDevice{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"devices": devices})
}

// DELETE /api/org/{id}/devices/{did}
func (s *Server) handleUnassignOrgDevice(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	deviceID := r.PathValue("did")
	if deviceID == "" {
		http.Error(w, `{"error":"device_id required"}`, http.StatusBadRequest)
		return
	}

	if err := s.db.UnassignDeviceFromOrg(orgID, deviceID); err != nil {
		log.Printf("[org] UnassignDeviceFromOrg error: %v", err)
		http.Error(w, `{"error":"failed to unassign device"}`, http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
//  Org Invitations
// ---------------------------------------------------------------------------

// POST /api/org/{id}/invite
func (s *Server) handleCreateOrgInvitation(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")

	var body struct {
		Email     string `json:"email"`
		Role      string `json:"role"`
		ExpiresIn int    `json:"expires_in_hours"` // default 72 hours
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	if body.Role == "" {
		body.Role = db.OrgRoleUser
	}
	if body.ExpiresIn <= 0 {
		body.ExpiresIn = 72
	}

	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		http.Error(w, `{"error":"token generation failed"}`, http.StatusInternalServerError)
		return
	}
	token := hex.EncodeToString(tokenBytes)

	inv := &db.OrgInvitation{
		ID:        uuid.New().String(),
		OrgID:     orgID,
		Token:     token,
		Email:     body.Email,
		Role:      body.Role,
		ExpiresAt: time.Now().UTC().Add(time.Duration(body.ExpiresIn) * time.Hour),
	}

	if err := s.db.CreateOrgInvitation(inv); err != nil {
		log.Printf("[org] CreateOrgInvitation error: %v", err)
		http.Error(w, `{"error":"failed to create invitation"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(inv)
}

// GET /api/org/{id}/invitations
func (s *Server) handleListOrgInvitations(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	invs, err := s.db.ListOrgInvitations(orgID)
	if err != nil {
		log.Printf("[org] ListOrgInvitations error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	if invs == nil {
		invs = []*db.OrgInvitation{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"invitations": invs})
}

// ---------------------------------------------------------------------------
//  Org Settings
// ---------------------------------------------------------------------------

// GET /api/org/{id}/settings
func (s *Server) handleListOrgSettings(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	settings, err := s.db.ListOrgSettings(orgID)
	if err != nil {
		log.Printf("[org] ListOrgSettings error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	if settings == nil {
		settings = []*db.OrgSetting{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"settings": settings})
}

// PUT /api/org/{id}/settings
func (s *Server) handleSetOrgSetting(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")

	var body struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	if body.Key == "" {
		http.Error(w, `{"error":"key is required"}`, http.StatusBadRequest)
		return
	}

	if err := s.db.SetOrgSetting(orgID, body.Key, body.Value); err != nil {
		log.Printf("[org] SetOrgSetting error: %v", err)
		http.Error(w, `{"error":"failed to save setting"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// ---------------------------------------------------------------------------
//  Org User Login
// ---------------------------------------------------------------------------

// POST /api/org/login
func (s *Server) handleOrgLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OrgSlug  string `json:"org_slug"`
		OrgID    string `json:"org_id"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	body.Username = strings.TrimSpace(body.Username)
	if body.Username == "" || body.Password == "" {
		http.Error(w, `{"error":"username and password are required"}`, http.StatusBadRequest)
		return
	}

	// Resolve org
	var orgID string
	if body.OrgID != "" {
		orgID = body.OrgID
	} else if body.OrgSlug != "" {
		org, _ := s.db.GetOrganizationBySlug(body.OrgSlug)
		if org == nil {
			http.Error(w, `{"error":"organization not found"}`, http.StatusNotFound)
			return
		}
		orgID = org.ID
	} else {
		http.Error(w, `{"error":"org_id or org_slug is required"}`, http.StatusBadRequest)
		return
	}

	user, _ := s.db.GetOrgUserByUsername(orgID, body.Username)
	if user == nil {
		// Timing-safe: compare against dummy hash
		bcrypt.CompareHashAndPassword(
			[]byte("$2a$10$XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"),
			[]byte(body.Password),
		)
		http.Error(w, `{"error":"invalid credentials"}`, http.StatusUnauthorized)
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.Password)); err != nil {
		http.Error(w, `{"error":"invalid credentials"}`, http.StatusUnauthorized)
		return
	}

	// Update last login
	s.db.UpdateOrgUserLogin(user.ID)

	// Generate JWT
	if s.jwtManager == nil {
		http.Error(w, `{"error":"JWT not configured"}`, http.StatusInternalServerError)
		return
	}

	token, err := s.jwtManager.Generate(user.Username, user.Role)
	if err != nil {
		log.Printf("[org] JWT generation error: %v", err)
		http.Error(w, `{"error":"token generation failed"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"token":        token,
		"user":         user,
		"org_id":       orgID,
		"type":         "org_user",
	})
}
