/**
 * Career Stage Inference & Compatibility
 * Shared utility used across CDP routes.
 *
 * Stages (matching program tag values):
 *   high_school | community_college | undergraduate | graduate | phd | postdoc | professional
 *
 * A student can have MULTIPLE simultaneous stages (e.g. grad student with a job = ['graduate', 'professional']).
 * inferCareerStages() returns an array. isStageCompatible() accepts an array.
 */

const STAGE_HIERARCHY = {
  high_school: 1,
  community_college: 2,
  undergraduate: 3,
  graduate: 4,
  phd: 5,
  postdoc: 6,
  professional: 4, // peers with graduate — can apply to graduate + professional + postdoc programs
};

const VALID_STAGES = new Set(Object.keys(STAGE_HIERARCHY));

/**
 * Infer career stages from student profile + experience array.
 * Returns an ARRAY of applicable stages (a student can be in multiple simultaneously).
 *
 * Examples:
 *   - PhD student with a current job → ['phd', 'professional']
 *   - Graduate student, no current job → ['graduate']
 *   - Undergrad with part-time job → ['undergraduate', 'professional']
 *
 * @param {object} profile  - student profile object (profile.year, profile.career_stage)
 * @param {Array}  experience - student experience entries [{type, endDate, ...}]
 * @returns {string[]} array of career stages
 */
function inferCareerStages(profile = {}, experience = []) {
  // Explicit array override in profile takes priority
  if (Array.isArray(profile.career_stage) && profile.career_stage.length > 0) {
    return profile.career_stage.filter(s => VALID_STAGES.has(s));
  }
  // Single string override (legacy/manual set)
  if (profile.career_stage && VALID_STAGES.has(profile.career_stage)) {
    return [profile.career_stage];
  }

  const stages = new Set();
  const year = (profile.year || '').toLowerCase().trim();

  // Check for active current job — adds 'professional' but does NOT exclude academic stage
  const hasCurrentJob = experience.some(e => e.type === 'work' && !e.endDate);
  if (hasCurrentJob) stages.add('professional');

  // Year-based detection — can coexist with professional
  if (year.includes('phd') || year.includes('doct')) {
    stages.add('phd');
  } else if (year.includes('grad') || year.includes('master')) {
    stages.add('graduate');
  } else if (year.includes('community') || year === 'cc') {
    stages.add('community_college');
  } else if (year.includes('high school') || year === 'hs') {
    stages.add('high_school');
  } else if (
    year.includes('fresh') || year.includes('soph') ||
    year.includes('junior') || year.includes('senior') ||
    year.includes('undergrad') || year.includes('other')
  ) {
    stages.add('undergraduate');
  } else if (year === 'working professional' || year === 'professional') {
    stages.add('professional'); // already added if hasCurrentJob, but harmless
  }

  // Default: undergraduate (most common) if nothing detected
  if (stages.size === 0) stages.add('undergraduate');

  return [...stages];
}

/**
 * @deprecated Use inferCareerStages (returns array). Kept for backward compat.
 * Returns the "primary" career stage (highest rank, or 'professional' if it's the only one).
 */
function inferCareerStage(profile = {}, experience = []) {
  const stages = inferCareerStages(profile, experience);
  if (stages.length === 1) return stages[0];
  // Pick the non-professional stage if there's one (professional is additive)
  const nonPro = stages.filter(s => s !== 'professional');
  return nonPro.length > 0 ? nonPro[0] : stages[0];
}

/**
 * Returns true if a student with `studentStages` is eligible for a program
 * tagged with `programStages`.
 *
 * Accepts both single string (legacy) and array for studentStages.
 *
 * Rules per stage:
 * - 'any' tag → always eligible
 * - professional → eligible for: graduate, professional, postdoc, phd
 * - phd → eligible for: phd, postdoc, graduate
 * - graduate → eligible for: graduate, phd
 * - undergraduate → eligible for: undergraduate, community_college, high_school
 * - community_college → eligible for: community_college, undergraduate
 * - high_school → eligible for: high_school
 *
 * @param {string[]} programStages - array of career_stage tags on the program
 * @param {string|string[]} studentStages - student's career stage(s)
 * @returns {boolean}
 */
function isStageCompatible(programStages, studentStages) {
  if (!programStages || programStages.length === 0) return true; // untagged = open
  if (programStages.includes('any')) return true;

  // Normalize to array
  const stages = Array.isArray(studentStages) ? studentStages : [studentStages];

  // Eligible if ANY of the student's stages match
  return stages.some(stage => {
    switch (stage) {
      case 'professional':
        return programStages.some(s => ['professional', 'graduate', 'phd', 'postdoc'].includes(s));
      case 'phd':
        return programStages.some(s => ['phd', 'postdoc', 'graduate'].includes(s));
      case 'graduate':
        return programStages.some(s => ['graduate', 'phd'].includes(s));
      case 'undergraduate':
        return programStages.some(s => ['undergraduate', 'community_college', 'high_school'].includes(s));
      case 'community_college':
        return programStages.some(s => ['community_college', 'undergraduate'].includes(s));
      case 'high_school':
        return programStages.some(s => ['high_school'].includes(s));
      default:
        return true;
    }
  });
}

/**
 * Human-readable label for a career stage or array of stages.
 */
function stageLabel(stage) {
  const labels = {
    high_school: 'High School',
    community_college: 'Community College',
    undergraduate: 'Undergraduate',
    graduate: 'Graduate',
    phd: 'PhD',
    postdoc: 'Postdoc',
    professional: 'Working Professional',
  };
  if (Array.isArray(stage)) {
    return stage.map(s => labels[s] || s).join(', ');
  }
  return labels[stage] || stage;
}

/**
 * Normalize career_stage from DB (may be JSON array string, JSON array, or legacy single string)
 * Always returns an array.
 */
function parseCareerStages(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(s => VALID_STAGES.has(s));
  if (typeof raw === 'string') {
    // Try JSON array
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.filter(s => VALID_STAGES.has(s));
      } catch { /* fall through */ }
    }
    // Legacy single value
    if (VALID_STAGES.has(raw)) return [raw];
  }
  return [];
}

module.exports = { inferCareerStages, inferCareerStage, isStageCompatible, stageLabel, parseCareerStages, STAGE_HIERARCHY };
