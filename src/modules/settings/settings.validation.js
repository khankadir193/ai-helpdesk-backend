// Allowlist of supported timezones
export const SUPPORTED_TIMEZONES = [
  "(UTC-08:00) Pacific Time",
  "(UTC-07:00) Mountain Time",
  "(UTC-06:00) Central Time",
  "(UTC-05:00) Eastern Time",
  "(UTC+00:00) UTC",
  "(UTC+01:00) Central European Time",
  "(UTC+05:30) India Standard Time",
  "(UTC+08:00) Singapore Time",
  "(UTC+09:00) Japan Standard Time",
  "(UTC+10:00) Australian Eastern Time",
];

// Allowlist of supported languages
export const SUPPORTED_LANGUAGES = [
  "English (United States)",
  "English (United Kingdom)",
  "Spanish (Español)",
  "French (Français)",
  "German (Deutsch)",
  "Japanese (日本語)",
  "Portuguese (Português)",
];

// Supported Ticket Priorities
export const SUPPORTED_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];

// Supported Assignment Methods
export const SUPPORTED_ASSIGNMENT_METHODS = [
  "ROUND_ROBIN",
  "LEAST_BUSY",
  "MANUAL_TRIAGE",
];

// Supported Fallbacks
export const SUPPORTED_FALLBACKS = [
  "UNASSIGNED_QUEUE",
  "TEAM_LEAD",
  "AUTO_RESOLVE_WARN",
];

// Supported AI Tones
export const SUPPORTED_AI_TONES = [
  "FRIENDLY_PROFESSIONAL",
  "DIRECT_CONCISE",
  "EMPATHETIC_SUPPORTIVE",
  "FORMAL_TECHNICAL",
];

// Supported Draft Modes
export const SUPPORTED_DRAFT_MODES = [
  "ON_REQUEST",
  "AUTOMATIC",
  "OFF",
];

// Validation schemas for `validate` middleware
export const patchWorkspaceSchema = {
  name: {
    type: "string",
    minLength: 2,
    maxLength: 100,
  },
  url: {
    type: "string",
    minLength: 3,
    maxLength: 120,
    pattern: /^[a-z0-9-]+(\.helpdesk\.ai)?$/,
    message: "Workspace URL must contain only lowercase letters, numbers, and hyphens",
  },
  support_email: {
    type: "string",
    maxLength: 254,
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    message: "Support email must be a valid email address",
  },
  timezone: {
    type: "string",
  },
  language: {
    type: "string",
  },
};

export const patchProfileSchema = {
  name: {
    type: "string",
    minLength: 2,
    maxLength: 100,
  },
  job_title: {
    type: "string",
    minLength: 1,
    maxLength: 120,
  },
  email: {
    type: "string",
    maxLength: 254,
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    message: "Email must be a valid email address",
  },
};

export const changePasswordSchema = {
  currentPassword: {
    type: "string",
    required: true,
    minLength: 1,
  },
  newPassword: {
    type: "string",
    required: true,
    minLength: 8,
    maxLength: 72,
    message: "New password must be between 8 and 72 characters",
  },
  confirmPassword: {
    type: "string",
    required: true,
    minLength: 8,
    maxLength: 72,
  },
};

export const patchTeamSchema = {
  default_team: {
    type: "string",
    maxLength: 100,
  },
  default_priority: {
    type: "string",
  },
  assignment_method: {
    type: "string",
  },
  fallback_action: {
    type: "string",
  },
  route_available_only: {
    type: "boolean",
  },
};

export const patchAiSchema = {
  ai_enabled: {
    type: "boolean",
  },
  redact_sensitive: {
    type: "boolean",
  },
  default_tone: {
    type: "string",
  },
  draft_mode: {
    type: "string",
  },
};
