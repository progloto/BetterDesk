// Organization CRUD operations for PostgreSQL backend (v3.0.0).
package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ---------------------------------------------------------------------------
//  Organizations
// ---------------------------------------------------------------------------

func (pg *PostgresDB) CreateOrganization(o *Organization) error {
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO organizations (id, name, slug, logo_url, settings, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
		o.ID, o.Name, o.Slug, o.LogoURL, o.Settings, o.CreatedAt.UTC(),
	)
	return err
}

func (pg *PostgresDB) GetOrganization(id string) (*Organization, error) {
	var o Organization
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT id, name, slug, logo_url, settings, created_at FROM organizations WHERE id = $1`, id,
	).Scan(&o.ID, &o.Name, &o.Slug, &o.LogoURL, &o.Settings, &o.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &o, nil
}

func (pg *PostgresDB) GetOrganizationBySlug(slug string) (*Organization, error) {
	var o Organization
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT id, name, slug, logo_url, settings, created_at FROM organizations WHERE slug = $1`, slug,
	).Scan(&o.ID, &o.Name, &o.Slug, &o.LogoURL, &o.Settings, &o.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &o, nil
}

func (pg *PostgresDB) ListOrganizations() ([]*Organization, error) {
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT id, name, slug, logo_url, settings, created_at FROM organizations ORDER BY name`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var orgs []*Organization
	for rows.Next() {
		var o Organization
		if err := rows.Scan(&o.ID, &o.Name, &o.Slug, &o.LogoURL, &o.Settings, &o.CreatedAt); err != nil {
			return nil, err
		}
		orgs = append(orgs, &o)
	}
	return orgs, rows.Err()
}

func (pg *PostgresDB) UpdateOrganization(o *Organization) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE organizations SET name = $1, slug = $2, logo_url = $3, settings = $4 WHERE id = $5`,
		o.Name, o.Slug, o.LogoURL, o.Settings, o.ID,
	)
	return err
}

func (pg *PostgresDB) DeleteOrganization(id string) error {
	tx, err := pg.pool.Begin(pg.ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())

	tx.Exec(pg.ctx, `DELETE FROM org_settings WHERE org_id = $1`, id)
	tx.Exec(pg.ctx, `DELETE FROM org_invitations WHERE org_id = $1`, id)
	tx.Exec(pg.ctx, `DELETE FROM org_devices WHERE org_id = $1`, id)
	tx.Exec(pg.ctx, `DELETE FROM org_users WHERE org_id = $1`, id)
	if _, err := tx.Exec(pg.ctx, `DELETE FROM organizations WHERE id = $1`, id); err != nil {
		return err
	}
	return tx.Commit(pg.ctx)
}

// ---------------------------------------------------------------------------
//  Org Users
// ---------------------------------------------------------------------------

func (pg *PostgresDB) CreateOrgUser(u *OrgUser) error {
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO org_users (id, org_id, username, display_name, email, password_hash, role, totp_secret, avatar_url, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		u.ID, u.OrgID, u.Username, u.DisplayName, u.Email, u.PasswordHash,
		u.Role, u.TOTPSecret, u.AvatarURL, u.CreatedAt.UTC(),
	)
	return err
}

func (pg *PostgresDB) GetOrgUser(id string) (*OrgUser, error) {
	var u OrgUser
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT id, org_id, username, display_name, email, password_hash, role, totp_secret, avatar_url, last_login, created_at
		 FROM org_users WHERE id = $1`, id,
	).Scan(&u.ID, &u.OrgID, &u.Username, &u.DisplayName, &u.Email,
		&u.PasswordHash, &u.Role, &u.TOTPSecret, &u.AvatarURL, &u.LastLogin, &u.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (pg *PostgresDB) GetOrgUserByUsername(orgID, username string) (*OrgUser, error) {
	var u OrgUser
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT id, org_id, username, display_name, email, password_hash, role, totp_secret, avatar_url, last_login, created_at
		 FROM org_users WHERE org_id = $1 AND username = $2`, orgID, username,
	).Scan(&u.ID, &u.OrgID, &u.Username, &u.DisplayName, &u.Email,
		&u.PasswordHash, &u.Role, &u.TOTPSecret, &u.AvatarURL, &u.LastLogin, &u.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (pg *PostgresDB) ListOrgUsers(orgID string) ([]*OrgUser, error) {
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT id, org_id, username, display_name, email, password_hash, role, totp_secret, avatar_url, last_login, created_at
		 FROM org_users WHERE org_id = $1 ORDER BY username`, orgID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []*OrgUser
	for rows.Next() {
		var u OrgUser
		if err := rows.Scan(&u.ID, &u.OrgID, &u.Username, &u.DisplayName, &u.Email,
			&u.PasswordHash, &u.Role, &u.TOTPSecret, &u.AvatarURL, &u.LastLogin, &u.CreatedAt); err != nil {
			return nil, err
		}
		users = append(users, &u)
	}
	return users, rows.Err()
}

func (pg *PostgresDB) UpdateOrgUser(u *OrgUser) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE org_users SET display_name = $1, email = $2, role = $3, totp_secret = $4, avatar_url = $5
		 WHERE id = $6`,
		u.DisplayName, u.Email, u.Role, u.TOTPSecret, u.AvatarURL, u.ID,
	)
	return err
}

func (pg *PostgresDB) DeleteOrgUser(id string) error {
	_, err := pg.pool.Exec(pg.ctx, `DELETE FROM org_users WHERE id = $1`, id)
	return err
}

func (pg *PostgresDB) UpdateOrgUserLogin(id string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE org_users SET last_login = NOW() WHERE id = $1`, id,
	)
	return err
}

// ---------------------------------------------------------------------------
//  Org Devices
// ---------------------------------------------------------------------------

func (pg *PostgresDB) AssignDeviceToOrg(d *OrgDevice) error {
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO org_devices (org_id, device_id, assigned_user_id, department, location, building, tags)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 ON CONFLICT (org_id, device_id) DO UPDATE SET
			assigned_user_id = EXCLUDED.assigned_user_id,
			department = EXCLUDED.department,
			location = EXCLUDED.location,
			building = EXCLUDED.building,
			tags = EXCLUDED.tags`,
		d.OrgID, d.DeviceID, d.AssignedUserID, d.Department, d.Location, d.Building, d.Tags,
	)
	return err
}

func (pg *PostgresDB) UnassignDeviceFromOrg(orgID, deviceID string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`DELETE FROM org_devices WHERE org_id = $1 AND device_id = $2`, orgID, deviceID,
	)
	return err
}

func (pg *PostgresDB) GetOrgDevice(orgID, deviceID string) (*OrgDevice, error) {
	var d OrgDevice
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT org_id, device_id, assigned_user_id, department, location, building, tags
		 FROM org_devices WHERE org_id = $1 AND device_id = $2`, orgID, deviceID,
	).Scan(&d.OrgID, &d.DeviceID, &d.AssignedUserID, &d.Department, &d.Location, &d.Building, &d.Tags)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func (pg *PostgresDB) ListOrgDevices(orgID string) ([]*OrgDevice, error) {
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT org_id, device_id, assigned_user_id, department, location, building, tags
		 FROM org_devices WHERE org_id = $1 ORDER BY device_id`, orgID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var devices []*OrgDevice
	for rows.Next() {
		var d OrgDevice
		if err := rows.Scan(&d.OrgID, &d.DeviceID, &d.AssignedUserID, &d.Department, &d.Location, &d.Building, &d.Tags); err != nil {
			return nil, err
		}
		devices = append(devices, &d)
	}
	return devices, rows.Err()
}

func (pg *PostgresDB) UpdateOrgDevice(d *OrgDevice) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE org_devices SET assigned_user_id = $1, department = $2, location = $3, building = $4, tags = $5
		 WHERE org_id = $6 AND device_id = $7`,
		d.AssignedUserID, d.Department, d.Location, d.Building, d.Tags, d.OrgID, d.DeviceID,
	)
	return err
}

// ---------------------------------------------------------------------------
//  Org Invitations
// ---------------------------------------------------------------------------

func (pg *PostgresDB) CreateOrgInvitation(inv *OrgInvitation) error {
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO org_invitations (id, org_id, token, email, role, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		inv.ID, inv.OrgID, inv.Token, inv.Email, inv.Role, inv.ExpiresAt.UTC(),
	)
	return err
}

func (pg *PostgresDB) GetOrgInvitationByToken(token string) (*OrgInvitation, error) {
	var inv OrgInvitation
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT id, org_id, token, email, role, expires_at, used_at
		 FROM org_invitations WHERE token = $1`, token,
	).Scan(&inv.ID, &inv.OrgID, &inv.Token, &inv.Email, &inv.Role, &inv.ExpiresAt, &inv.UsedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &inv, nil
}

func (pg *PostgresDB) ListOrgInvitations(orgID string) ([]*OrgInvitation, error) {
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT id, org_id, token, email, role, expires_at, used_at
		 FROM org_invitations WHERE org_id = $1 ORDER BY expires_at DESC`, orgID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var invs []*OrgInvitation
	for rows.Next() {
		var inv OrgInvitation
		if err := rows.Scan(&inv.ID, &inv.OrgID, &inv.Token, &inv.Email, &inv.Role, &inv.ExpiresAt, &inv.UsedAt); err != nil {
			return nil, err
		}
		invs = append(invs, &inv)
	}
	return invs, rows.Err()
}

func (pg *PostgresDB) UseOrgInvitation(token string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE org_invitations SET used_at = NOW() WHERE token = $1`, token,
	)
	return err
}

func (pg *PostgresDB) DeleteOrgInvitation(id string) error {
	_, err := pg.pool.Exec(pg.ctx, `DELETE FROM org_invitations WHERE id = $1`, id)
	return err
}

// ---------------------------------------------------------------------------
//  Org Settings
// ---------------------------------------------------------------------------

func (pg *PostgresDB) GetOrgSetting(orgID, key string) (string, error) {
	var value string
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT value FROM org_settings WHERE org_id = $1 AND key = $2`, orgID, key,
	).Scan(&value)
	if err == pgx.ErrNoRows {
		return "", fmt.Errorf("org setting not found: %s/%s", orgID, key)
	}
	return value, err
}

func (pg *PostgresDB) SetOrgSetting(orgID, key, value string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO org_settings (org_id, key, value) VALUES ($1, $2, $3)
		 ON CONFLICT (org_id, key) DO UPDATE SET value = EXCLUDED.value`,
		orgID, key, value,
	)
	return err
}

func (pg *PostgresDB) DeleteOrgSetting(orgID, key string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`DELETE FROM org_settings WHERE org_id = $1 AND key = $2`, orgID, key,
	)
	return err
}

func (pg *PostgresDB) ListOrgSettings(orgID string) ([]*OrgSetting, error) {
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT org_id, key, value FROM org_settings WHERE org_id = $1 ORDER BY key`, orgID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var settings []*OrgSetting
	for rows.Next() {
		var s OrgSetting
		if err := rows.Scan(&s.OrgID, &s.Key, &s.Value); err != nil {
			return nil, err
		}
		settings = append(settings, &s)
	}
	return settings, rows.Err()
}
