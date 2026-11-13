import bcrypt from "bcrypt";
import database from "../../config/database.js";
import ApiError from "../../utils/ApiError.js";
import {
  SUPPORTED_TIMEZONES,
  SUPPORTED_LANGUAGES,
  SUPPORTED_PRIORITIES,
  SUPPORTED_ASSIGNMENT_METHODS,
  SUPPORTED_FALLBACKS,
  SUPPORTED_AI_TONES,
  SUPPORTED_DRAFT_MODES,
} from "./settings.validation.js";

const BCRYPT_ROUNDS = 12;

// AI Preview responses mapped to tone
const AI_TONE_PREVIEWS = {
  FRIENDLY_PROFESSIONAL:
    "Hi Sarah, thanks for reaching out. You can download your invoice from Settings \u2192 Billing. Let me know if you need help finding it.",
  DIRECT_CONCISE:
    "Hello Sarah. Your invoice is available in Settings \u2192 Billing for download.",
  EMPATHETIC_SUPPORTIVE:
    "Hi Sarah, I understand how important it is to access your billing details promptly. You can download your invoice under Settings \u2192 Billing. I'm right here if you need any further assistance!",
  FORMAL_TECHNICAL:
    "Dear Sarah, please be advised that invoices may be accessed and retrieved directly via Settings \u2192 Billing in the administration portal.",
};

/**
 * -----------------------------------------------------------------------------
 * 1. WORKSPACE SETTINGS
 * -----------------------------------------------------------------------------
 */
async function getWorkspaceSettings() {
  const { rows } = await database.query(`
    SELECT ws.id, ws.workspace_id, ws.name, ws.url, ws.support_email, ws.timezone, ws.language,
           ws.created_at, u.name AS owner_name
    FROM workspace_settings ws
    LEFT JOIN users u ON u.id = ws.owner_id
    ORDER BY ws.id ASC
    LIMIT 1
  `);

  if (rows.length === 0) {
    return {
      workspace_id: "ws_acme_001",
      name: "Acme Support",
      url: "acme.helpdesk.ai",
      support_email: "support@acme.com",
      timezone: "(UTC-08:00) Pacific Time",
      language: "English (United States)",
      created_at: new Date("2026-10-01T00:00:00Z"),
      owner_name: "Alex Morgan",
    };
  }

  const row = rows[0];
  return {
    workspace_id: row.workspace_id,
    name: row.name,
    url: row.url,
    support_email: row.support_email,
    timezone: row.timezone,
    language: row.language,
    created_at: row.created_at,
    owner_name: row.owner_name || "Alex Morgan",
  };
}

async function updateWorkspaceSettings(patchData) {
  const current = await getWorkspaceSettings();

  const name = patchData.name !== undefined ? patchData.name.trim() : current.name;
  let url = patchData.url !== undefined ? patchData.url.trim().toLowerCase() : current.url;
  const support_email =
    patchData.support_email !== undefined
      ? patchData.support_email.trim().toLowerCase()
      : current.support_email;
  const timezone = patchData.timezone !== undefined ? patchData.timezone : current.timezone;
  const language = patchData.language !== undefined ? patchData.language : current.language;

  // Normalize URL format
  if (url && !url.includes(".")) {
    url = `${url}.helpdesk.ai`;
  }

  if (patchData.timezone && !SUPPORTED_TIMEZONES.includes(timezone)) {
    throw new ApiError(400, `Unsupported timezone: ${timezone}`);
  }

  if (patchData.language && !SUPPORTED_LANGUAGES.includes(language)) {
    throw new ApiError(400, `Unsupported language: ${language}`);
  }

  // Check URL conflict with other workspaces
  const { rows: conflict } = await database.query(
    "SELECT id FROM workspace_settings WHERE LOWER(url) = LOWER($1) AND workspace_id != $2",
    [url, current.workspace_id]
  );
  if (conflict.length > 0) {
    throw new ApiError(409, "Workspace URL is already taken. Please choose another.");
  }

  await database.query(
    `UPDATE workspace_settings
     SET name = $1, url = $2, support_email = $3, timezone = $4, language = $5, updated_at = now()
     WHERE workspace_id = $6`,
    [name, url, support_email, timezone, language, current.workspace_id]
  );

  return getWorkspaceSettings();
}

async function checkWorkspaceUrl(urlRaw, currentWorkspaceId = "ws_acme_001") {
  if (!urlRaw || typeof urlRaw !== "string") {
    throw new ApiError(400, "URL parameter is required");
  }

  let normalized = urlRaw.trim().toLowerCase();
  if (!normalized.includes(".")) {
    normalized = `${normalized}.helpdesk.ai`;
  }

  const { rows } = await database.query(
    "SELECT id FROM workspace_settings WHERE LOWER(url) = LOWER($1) AND workspace_id != $2",
    [normalized, currentWorkspaceId]
  );

  return {
    url: normalized,
    available: rows.length === 0,
  };
}

/**
 * -----------------------------------------------------------------------------
 * 2. PROFILE SETTINGS
 * -----------------------------------------------------------------------------
 */
async function getUserProfile(userId) {
  const { rows } = await database.query(
    `SELECT u.id, u.name, u.email, u.role, u.created_at,
            COALESCE(up.job_title, 'Customer Support Manager') AS job_title,
            up.avatar_url,
            COALESCE(up.password_changed_at, u.created_at) AS password_changed_at,
            COALESCE(up.two_factor_enabled, true) AS two_factor_enabled,
            COALESCE(up.two_factor_secret, 'authenticator-app') AS two_factor_secret
     FROM users u
     LEFT JOIN user_profiles up ON up.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  );

  if (rows.length === 0) {
    throw new ApiError(404, "User not found");
  }

  const user = rows[0];
  return {
    id: String(user.id),
    name: user.name,
    email: user.email,
    role: user.role,
    job_title: user.job_title,
    avatar_url: user.avatar_url || null,
    email_verified: true,
    password_last_changed: user.password_changed_at,
    two_factor_enabled: user.two_factor_enabled,
    workspace_name: "Acme Support",
  };
}

async function updateUserProfile(userId, patchData) {
  const current = await getUserProfile(userId);

  const name = patchData.name !== undefined ? patchData.name.trim() : current.name;
  const job_title =
    patchData.job_title !== undefined ? patchData.job_title.trim() : current.job_title;
  const email =
    patchData.email !== undefined ? patchData.email.trim().toLowerCase() : current.email;

  // Check email uniqueness if modified
  if (email !== current.email) {
    const { rows: duplicate } = await database.query(
      "SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id != $2",
      [email, userId]
    );
    if (duplicate.length > 0) {
      throw new ApiError(409, "Email address is already in use by another account.");
    }
  }

  // Update users table
  await database.query(
    "UPDATE users SET name = $1, email = $2, updated_at = now() WHERE id = $3",
    [name, email, userId]
  );

  // Upsert user_profiles table
  await database.query(
    `INSERT INTO user_profiles (user_id, job_title, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id)
     DO UPDATE SET job_title = EXCLUDED.job_title, updated_at = now()`,
    [userId, job_title]
  );

  return getUserProfile(userId);
}

async function uploadAvatar(userId, avatarData) {
  if (!avatarData || typeof avatarData !== "string") {
    throw new ApiError(400, "Invalid avatar data");
  }

  // Must be PNG or JPEG base64 data URL
  const match = avatarData.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i);
  if (!match) {
    throw new ApiError(400, "Only JPG and PNG images are supported");
  }

  // Check approximate size (max 2 MB = ~2,796,202 base64 characters)
  const base64Data = match[2];
  const sizeInBytes = Math.ceil((base64Data.length * 3) / 4);
  if (sizeInBytes > 2 * 1024 * 1024) {
    throw new ApiError(400, "Image exceeds maximum size limit of 2 MB");
  }

  await database.query(
    `INSERT INTO user_profiles (user_id, avatar_url, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id)
     DO UPDATE SET avatar_url = EXCLUDED.avatar_url, updated_at = now()`,
    [userId, avatarData]
  );

  return {
    avatar_url: avatarData,
  };
}

async function changePassword(userId, { currentPassword, newPassword, confirmPassword }) {
  if (newPassword !== confirmPassword) {
    throw new ApiError(400, "New password and confirmation do not match");
  }

  if (newPassword.length < 8 || newPassword.length > 72) {
    throw new ApiError(400, "Password must be between 8 and 72 characters");
  }

  const { rows } = await database.query(
    "SELECT password_hash FROM users WHERE id = $1",
    [userId]
  );

  if (rows.length === 0) {
    throw new ApiError(404, "User not found");
  }

  const match = await bcrypt.compare(currentPassword, rows[0].password_hash);
  if (!match) {
    throw new ApiError(400, "Current password is incorrect");
  }

  const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  await database.query(
    "UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2",
    [newHash, userId]
  );

  await database.query(
    `INSERT INTO user_profiles (user_id, password_changed_at, updated_at)
     VALUES ($1, now(), now())
     ON CONFLICT (user_id)
     DO UPDATE SET password_changed_at = now(), updated_at = now()`,
    [userId]
  );

  return { message: "Password updated successfully." };
}

async function get2faStatus(userId) {
  const { rows } = await database.query(
    "SELECT two_factor_enabled FROM user_profiles WHERE user_id = $1",
    [userId]
  );

  const enabled = rows.length > 0 ? rows[0].two_factor_enabled : true;
  return {
    enabled,
    method: "Authenticator app",
  };
}

async function update2faStatus(userId, { enabled }) {
  const isEnabled = Boolean(enabled);

  await database.query(
    `INSERT INTO user_profiles (user_id, two_factor_enabled, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id)
     DO UPDATE SET two_factor_enabled = EXCLUDED.two_factor_enabled, updated_at = now()`,
    [userId, isEnabled]
  );

  return {
    enabled: isEnabled,
    method: "Authenticator app",
  };
}

async function getUserSessions(userId, currentSessionId, req) {
  // Parse user agent
  const userAgent = req.headers["user-agent"] || "";
  let browser = "Chrome on macOS";
  if (/Windows/i.test(userAgent)) {
    browser = "Chrome on Windows";
  } else if (/Mac/i.test(userAgent)) {
    browser = "Chrome on macOS";
  } else if (/Linux/i.test(userAgent)) {
    browser = "Firefox on Linux";
  }

  const currentSession = {
    id: currentSessionId || "current",
    browser,
    location: "San Francisco, US",
    current: true,
    active_now: true,
  };

  // Check how many sessions exist in DB for this user
  const { rows } = await database.query(
    `SELECT sid, expire, (sess->>'userId') as user_id
     FROM session
     WHERE sess->>'userId' = $1 AND expire > now()`,
    [String(userId)]
  );

  const otherSessions = rows
    .filter((r) => r.sid !== currentSessionId)
    .map((r) => ({
      id: r.sid,
      browser: "Chrome on macOS",
      location: "San Francisco, US",
      current: false,
      last_active: r.expire,
    }));

  return {
    current_session: currentSession,
    other_sessions: otherSessions,
    other_sessions_count: otherSessions.length,
  };
}

async function revokeOtherSessions(userId, currentSessionId) {
  const res = await database.query(
    `DELETE FROM session
     WHERE sess->>'userId' = $1 AND sid != $2`,
    [String(userId), currentSessionId || ""]
  );

  return {
    revoked_count: res.rowCount || 0,
    message: "Other sessions signed out successfully.",
  };
}

/**
 * -----------------------------------------------------------------------------
 * 3. TEAM SETTINGS
 * -----------------------------------------------------------------------------
 */
async function getTeamSettings() {
  const { rows } = await database.query(`
    SELECT default_team, default_priority, assignment_method, fallback_action,
           route_available_only, default_invitation_role, active_members_count, pending_invites_count
    FROM team_settings
    ORDER BY id ASC
    LIMIT 1
  `);

  // Count active members in users table
  const { rows: memberRows } = await database.query(
    "SELECT count(*) as count FROM users WHERE is_active = true"
  );
  const activeCount = parseInt(memberRows[0]?.count, 10) || 12;

  const defaults = rows[0] || {
    default_team: "Customer Support",
    default_priority: "MEDIUM",
    assignment_method: "ROUND_ROBIN",
    fallback_action: "UNASSIGNED_QUEUE",
    route_available_only: true,
    default_invitation_role: "Support Agent",
    active_members_count: 12,
    pending_invites_count: 2,
  };

  return {
    default_team: defaults.default_team,
    default_priority: defaults.default_priority,
    assignment_method: defaults.assignment_method,
    fallback_action: defaults.fallback_action,
    route_available_only: defaults.route_available_only,
    default_invitation_role: defaults.default_invitation_role,
    active_members_count: activeCount > 0 ? activeCount : defaults.active_members_count,
    pending_invites_count: defaults.pending_invites_count,
    options: {
      teams: ["Customer Support", "Technical Support", "Billing & Account", "VIP Triage"],
      priorities: SUPPORTED_PRIORITIES,
      assignment_methods: [
        { value: "ROUND_ROBIN", label: "Round robin" },
        { value: "LEAST_BUSY", label: "Least busy agent" },
        { value: "MANUAL_TRIAGE", label: "Manual triage" },
      ],
      fallback_actions: [
        { value: "UNASSIGNED_QUEUE", label: "Keep in unassigned queue" },
        { value: "TEAM_LEAD", label: "Assign to team lead" },
        { value: "AUTO_RESOLVE_WARN", label: "Queue with high priority" },
      ],
    },
  };
}

async function updateTeamSettings(patchData) {
  const current = await getTeamSettings();

  const default_team =
    patchData.default_team !== undefined ? patchData.default_team : current.default_team;
  const default_priority =
    patchData.default_priority !== undefined
      ? patchData.default_priority
      : current.default_priority;
  const assignment_method =
    patchData.assignment_method !== undefined
      ? patchData.assignment_method
      : current.assignment_method;
  const fallback_action =
    patchData.fallback_action !== undefined
      ? patchData.fallback_action
      : current.fallback_action;
  const route_available_only =
    patchData.route_available_only !== undefined
      ? Boolean(patchData.route_available_only)
      : current.route_available_only;

  if (patchData.default_priority && !SUPPORTED_PRIORITIES.includes(default_priority)) {
    throw new ApiError(400, `Invalid priority: ${default_priority}`);
  }
  if (
    patchData.assignment_method &&
    !SUPPORTED_ASSIGNMENT_METHODS.includes(assignment_method)
  ) {
    throw new ApiError(400, `Invalid assignment method: ${assignment_method}`);
  }
  if (patchData.fallback_action && !SUPPORTED_FALLBACKS.includes(fallback_action)) {
    throw new ApiError(400, `Invalid fallback action: ${fallback_action}`);
  }

  await database.query(
    `UPDATE team_settings
     SET default_team = $1, default_priority = $2, assignment_method = $3,
         fallback_action = $4, route_available_only = $5, updated_at = now()
     WHERE id = (SELECT id FROM team_settings ORDER BY id ASC LIMIT 1)`,
    [
      default_team,
      default_priority,
      assignment_method,
      fallback_action,
      route_available_only,
    ]
  );

  return getTeamSettings();
}

/**
 * -----------------------------------------------------------------------------
 * 4. NOTIFICATION SETTINGS
 * -----------------------------------------------------------------------------
 */
const DEFAULT_MATRIX = [
  {
    id: "ticket_assigned",
    label: "Ticket assigned to me",
    description: "New assignments and reassignments",
    in_app: true,
    email: true,
  },
  {
    id: "customer_replies",
    label: "Customer replies",
    description: "Replies on tickets assigned to me",
    in_app: true,
    email: true,
  },
  {
    id: "mentions_notes",
    label: "Mentions & internal notes",
    description: "When a teammate mentions me",
    in_app: true,
    email: true,
  },
  {
    id: "urgent_sla",
    label: "Urgent tickets & SLA risk",
    description: "Time-sensitive alerts for my team",
    in_app: true,
    email: false,
  },
  {
    id: "ai_draft",
    label: "AI draft ready for review",
    description: "AI-labeled suggestions on my tickets",
    in_app: true,
    email: false,
  },
];

async function getNotificationSettings(userId) {
  const { rows } = await database.query(
    `SELECT in_app_enabled, email_enabled, desktop_enabled, email_digest,
            quiet_hours_enabled, quiet_hours_start, quiet_hours_end, matrix
     FROM user_notification_settings
     WHERE user_id = $1`,
    [userId]
  );

  if (rows.length === 0) {
    return {
      channels: {
        in_app: true,
        email: true,
        desktop: false,
      },
      email_digest: "DAILY_8AM",
      quiet_hours: {
        enabled: true,
        start: "18:00",
        end: "08:00",
        timezone: "Pacific Time (UTC-08:00)",
      },
      matrix: DEFAULT_MATRIX,
    };
  }

  const s = rows[0];
  return {
    channels: {
      in_app: s.in_app_enabled,
      email: s.email_enabled,
      desktop: s.desktop_enabled,
    },
    email_digest: s.email_digest,
    quiet_hours: {
      enabled: s.quiet_hours_enabled,
      start: s.quiet_hours_start,
      end: s.quiet_hours_end,
      timezone: "Pacific Time (UTC-08:00)",
    },
    matrix: s.matrix || DEFAULT_MATRIX,
  };
}

async function updateNotificationSettings(userId, patchData) {
  const current = await getNotificationSettings(userId);

  const channels = {
    ...current.channels,
    ...(patchData.channels || {}),
  };
  const email_digest = patchData.email_digest || current.email_digest;
  const quiet_hours = {
    ...current.quiet_hours,
    ...(patchData.quiet_hours || {}),
  };
  const matrix = patchData.matrix || current.matrix;

  await database.query(
    `INSERT INTO user_notification_settings
     (user_id, in_app_enabled, email_enabled, desktop_enabled, email_digest,
      quiet_hours_enabled, quiet_hours_start, quiet_hours_end, matrix, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (user_id)
     DO UPDATE SET
       in_app_enabled = EXCLUDED.in_app_enabled,
       email_enabled = EXCLUDED.email_enabled,
       desktop_enabled = EXCLUDED.desktop_enabled,
       email_digest = EXCLUDED.email_digest,
       quiet_hours_enabled = EXCLUDED.quiet_hours_enabled,
       quiet_hours_start = EXCLUDED.quiet_hours_start,
       quiet_hours_end = EXCLUDED.quiet_hours_end,
       matrix = EXCLUDED.matrix,
       updated_at = now()`,
    [
      userId,
      channels.in_app,
      channels.email,
      channels.desktop,
      email_digest,
      quiet_hours.enabled,
      quiet_hours.start,
      quiet_hours.end,
      JSON.stringify(matrix),
    ]
  );

  return getNotificationSettings(userId);
}

/**
 * -----------------------------------------------------------------------------
 * 5. AI SETTINGS
 * -----------------------------------------------------------------------------
 */
async function getAiSettings() {
  const { rows } = await database.query(`
    SELECT ai_enabled, redact_sensitive, default_tone, draft_mode
    FROM ai_settings
    ORDER BY id ASC
    LIMIT 1
  `);

  const defaults = rows[0] || {
    ai_enabled: true,
    redact_sensitive: true,
    default_tone: "FRIENDLY_PROFESSIONAL",
    draft_mode: "ON_REQUEST",
  };

  // Dynamic KB articles count
  const { rows: kbRows } = await database.query(`
    SELECT count(*) AS count, max(updated_at) AS last_synced
    FROM kb_articles
    WHERE status = 'PUBLISHED'
  `);

  const articleCount = parseInt(kbRows[0]?.count, 10) || 48;
  const lastSynced = kbRows[0]?.last_synced || new Date();

  return {
    ai_enabled: defaults.ai_enabled,
    redact_sensitive: defaults.redact_sensitive,
    default_tone: defaults.default_tone,
    draft_mode: defaults.draft_mode,
    knowledge_sources: {
      connected: true,
      article_count: articleCount,
      last_synced_at: lastSynced,
    },
    options: {
      tones: [
        { value: "FRIENDLY_PROFESSIONAL", label: "Friendly & professional" },
        { value: "DIRECT_CONCISE", label: "Direct & concise" },
        { value: "EMPATHETIC_SUPPORTIVE", label: "Empathetic & supportive" },
        { value: "FORMAL_TECHNICAL", label: "Formal & technical" },
      ],
      draft_modes: [
        { value: "ON_REQUEST", label: "When an agent requests them" },
        { value: "AUTOMATIC", label: "Automatically on new tickets" },
        { value: "OFF", label: "Off" },
      ],
    },
  };
}

async function updateAiSettings(patchData) {
  const current = await getAiSettings();

  const ai_enabled =
    patchData.ai_enabled !== undefined ? Boolean(patchData.ai_enabled) : current.ai_enabled;
  const redact_sensitive =
    patchData.redact_sensitive !== undefined
      ? Boolean(patchData.redact_sensitive)
      : current.redact_sensitive;
  const default_tone =
    patchData.default_tone !== undefined ? patchData.default_tone : current.default_tone;
  const draft_mode =
    patchData.draft_mode !== undefined ? patchData.draft_mode : current.draft_mode;

  if (patchData.default_tone && !SUPPORTED_AI_TONES.includes(default_tone)) {
    throw new ApiError(400, `Invalid AI tone: ${default_tone}`);
  }
  if (patchData.draft_mode && !SUPPORTED_DRAFT_MODES.includes(draft_mode)) {
    throw new ApiError(400, `Invalid draft mode: ${draft_mode}`);
  }

  await database.query(
    `UPDATE ai_settings
     SET ai_enabled = $1, redact_sensitive = $2, default_tone = $3, draft_mode = $4, updated_at = now()
     WHERE id = (SELECT id FROM ai_settings ORDER BY id ASC LIMIT 1)`,
    [ai_enabled, redact_sensitive, default_tone, draft_mode]
  );

  return getAiSettings();
}

function getAiPreview(tone) {
  const normalizedTone = (tone || "FRIENDLY_PROFESSIONAL").toUpperCase();
  const preview =
    AI_TONE_PREVIEWS[normalizedTone] || AI_TONE_PREVIEWS.FRIENDLY_PROFESSIONAL;

  return {
    tone: normalizedTone,
    suggested_reply: preview,
    is_ai_generated: true,
    requires_human_review: true,
  };
}

export default {
  getWorkspaceSettings,
  updateWorkspaceSettings,
  checkWorkspaceUrl,
  getUserProfile,
  updateUserProfile,
  uploadAvatar,
  changePassword,
  get2faStatus,
  update2faStatus,
  getUserSessions,
  revokeOtherSessions,
  getTeamSettings,
  updateTeamSettings,
  getNotificationSettings,
  updateNotificationSettings,
  getAiSettings,
  updateAiSettings,
  getAiPreview,
};

