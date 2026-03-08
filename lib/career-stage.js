/**
 * Career Stage Inference & Compatibility
 * Shared utility used across CDP routes.
 *
 * Stages (matching program tag values):
 *   high_school | community_college | undergraduate | graduate | phd | postdoc | professional
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

/**
 * Infer career stage from student profile + experience array.
 * Returns a canonical stage string.
 *
 * @param {object} profile  - student profile object (profile.year, etc.)
 * @param {Array}  experience - student experience entries [{type, endDate, ...}]
 * @returns {string} career stage
 */
function inferCareerStage(profile = {}, experience = []) {
  const year = (profile.year || '').toLowerCase().trim();

  // Explicit override in profile takes priority
  if (profile.career_stage && STAGE_HIERARCHY[profile.career_stage] !== undefined) {
    return profile.career_stage;
  }

  // Check for active current job (any type=work with no endDate)
  const hasCurrentJob = experience.some(
    e => e.type === 'work' && !e.endDate
  );

  // Working professional detection — any year + current job = professional
  if (hasCurrentJob) return 'professional';

  // Year-based detection
  if (year.includes('phd') || year.includes('doct')) return 'phd';
  if (year.includes('grad') || year.includes('master')) return 'graduate';
  if (year.includes('community') || year.includes('cc')) return 'community_college';
  if (year.includes('high school') || year === 'hs') return 'high_school';
  if (
    year.includes('fresh') || year.includes('soph') ||
    year.includes('junior') || year.includes('senior') ||
    year.includes('undergrad') || year.includes('other')
  ) return 'undergraduate';
  if (year === 'working professional' || year === 'professional') return 'professional';

  // Default: undergraduate (most common)
  return 'undergraduate';
}

/**
 * Returns true if a student at `studentStage` is eligible for a program
 * tagged with `programStages`.
 *
 * Rules:
 * - 'any' tag → always eligible
 * - professional → eligible for: graduate, professional, postdoc, phd
 * - phd → eligible for: phd, postdoc, graduate (plus anything above)
 * - graduate → eligible for: graduate, phd
 * - undergraduate → eligible for: undergraduate, community_college, high_school
 * - community_college → eligible for: community_college, undergraduate
 * - high_school → eligible for: high_school
 *
 * @param {string[]} programStages - array of career_stage tags on the program
 * @param {string}   studentStage  - student's inferred career stage
 * @returns {boolean}
 */
function isStageCompatible(programStages, studentStage) {
  if (!programStages || programStages.length === 0) return true; // untagged = open
  if (programStages.includes('any')) return true;

  switch (studentStage) {
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
}

/**
 * Human-readable label for a career stage.
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
  return labels[stage] || stage;
}

module.exports = { inferCareerStage, isStageCompatible, stageLabel, STAGE_HIERARCHY };
