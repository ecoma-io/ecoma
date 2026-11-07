/**
 * Message catalog tiếng Anh — **nguồn sự thật cho tập key** của toàn bộ UI account.
 *
 * Catalog này định nghĩa *key*, không phải *nội dung*: `vi` và `zh-CN` phải có
 * đúng tập key này. Tính đồng nhất được kiểm bằng test `catalogs.spec.ts`, không
 * dựa vào kỷ luật khi viết — một key thừa ở đây là một key mà hai catalog còn
 * lại không dịch, và nó render ra chuỗi rỗng ở production.
 *
 * Quy ước: `zh-CN` là locale code (khớp `user_preferences.locale` ở server),
 * còn BCP-47 để SEO/`<html lang>` là `zh-Hans` — hai giá trị khác nhau, khai ở
 * `nuxt.config.ts` (`i18n.locales[].language`).
 */
export default {
  common: {
    save: 'Save changes',
    cancel: 'Cancel',
    remove: 'Remove',
    add: 'Add',
    confirm: 'Confirm',
    back: 'Back',
    close: 'Close',
    retry: 'Try again',
    dismiss: 'Dismiss',
    loading: 'Loading…',
    optional: 'optional',
    simulated: 'Simulated',
    unavailable: 'Not available',
    continue: 'Continue',
  },

  shell: {
    title: 'Account',
    skipToContent: 'Skip to main content',
    languageLabel: 'Language',
    languageHint: 'Changes the language of every page. The address stays the same.',
    navLabel: 'Account sections',
    mockBadge: 'Preview data',
    mockNotice:
      'Every value on these pages comes from a local preview adapter. Nothing here has been saved on an Ecoma server.',
  },

  nav: {
    personal: 'Personal information',
    emails: 'Email addresses',
    security: 'Security',
    sessions: 'Active sessions',
    applications: 'Connected applications',
    preferences: 'Personal preferences',
    notifications: 'Notification preferences',
    privacy: 'Privacy and personal data',
  },

  states: {
    errorTitle: 'Something went wrong',
    errorBody: 'We could not load this page. Try again, or contact support if it keeps happening.',
    saved: 'Saved',
    saveFailed: 'Not saved',
    emptyPersonal: 'No profile information yet.',
    emptyEmails: 'No email addresses yet.',
    emptySessions: 'No other active sessions.',
    emptyApplications: 'No applications have access to your account.',
    emptyPrivacy: 'You have not made any privacy requests.',
  },

  profile: {
    title: 'Personal information',
    description: 'The name and picture other people see when you use Ecoma.',
    displayName: 'Display name',
    displayNameHint: 'Shown instead of your email address in apps you connect.',
    avatar: 'Avatar',
    avatarHint: 'Preview adapter only — no image upload is wired up yet.',
    avatarAlt: 'Avatar of {name}',
    avatarMissing: 'No avatar set.',
  },

  emails: {
    title: 'Email addresses',
    description: 'A verified address is required to sign in. Ecoma sends no marketing mail.',
    address: 'Email address',
    status: 'Status',
    statusPending: 'Awaiting verification',
    statusVerified: 'Verified',
    add: 'Add an email address',
    addTitle: 'Add an email address',
    addDescription:
      'We send a verification link. The address can only be used to sign in after you confirm it.',
    addSubmit: 'Send verification link',
    addFailed: 'The verification link could not be sent.',
    verify: 'Resend link',
    verifySent: 'Verification link sent.',
    removeTitle: 'Remove this email address?',
    removeDescription: 'It can no longer be used to sign in, and mail to it will bounce.',
    removeBlocked:
      'This is your only verified address. Verify another address before removing this one.',
    removed: 'Email address removed.',
  },

  security: {
    title: 'Security',
    description:
      'Ecoma is passwordless. You sign in with an email link, and can add a second factor for stronger protection.',
    noPasswordNote:
      'Ecoma does not use passwords, so there is nothing to change, reset, or recover here.',
    passkeys: 'Passkeys',
    passkeyHint: 'A passkey unlocks a sign-in on one device using its biometrics or PIN.',
    passkeyName: 'Device name',
    passkeyNamePlaceholder: 'For example: Laptop',
    passkeyAdd: 'Add a passkey',
    passkeyRemoved: 'Passkey removed.',
    passkeyEmpty: 'No passkeys yet.',
    totp: 'Authenticator app',
    totpHint: 'A six-digit code from an authenticator app, for when you cannot open your email.',
    totpEnroll: 'Turn on authenticator app',
    totpDisable: 'Turn off',
    recoveryCodes: 'Recovery codes',
    recoveryCodesHint: 'Single-use codes for when you lose both your email and your authenticator.',
    recoveryCodesRemaining: '{count} codes remaining',
    recoveryCodesRegenerate: 'Generate new codes',
    recoveryCodesReveal: 'Show codes',
    recoveryCodesWarning: 'These codes are shown once. Store them somewhere safe before closing.',
  },

  sessions: {
    title: 'Active sessions',
    description: 'Devices currently signed in to your Ecoma account.',
    current: 'This device',
    device: 'Device',
    location: 'Approximate location',
    lastSeen: 'Last activity',
    signedInAt: 'Signed in',
    expiresAt: 'Expires',
    revoke: 'Sign out',
    revokeTitle: 'Sign out of this session?',
    revokeDescription: 'That device will have to sign in again with an email link.',
    revoked: 'Session signed out.',
  },

  applications: {
    title: 'Connected applications',
    description: 'Applications you have allowed to act on your behalf.',
    grantedAt: 'Connected',
    scopes: 'This application can',
    noScopes: 'No specific permissions were requested.',
    revoke: 'Remove access',
    revokeTitle: 'Remove this application?',
    revokeDescription: 'It loses access immediately and its existing tokens stop working.',
    revoked: 'Access removed.',
  },

  preferences: {
    title: 'Personal preferences',
    description: 'How Ecoma displays dates, times, and colours for you.',
    language: 'Language',
    timezone: 'Time zone',
    timezoneHint: 'IANA name, for example Asia/Ho_Chi_Minh.',
    timezoneInvalid: 'That is not a valid IANA time zone name.',
    colorMode: 'Colour mode',
    colorModeSystem: 'Match system',
    colorModeLight: 'Light',
    colorModeDark: 'Dark',
    colorModeHint:
      'Colour mode is not applied yet. The saved value takes effect once the dark theme ships.',
    saveFailed: 'Your preference could not be saved, so the change was not kept.',
  },

  notifications: {
    title: 'Notification preferences',
    description: 'Which messages Ecoma may send you. This is your intent, not a list of devices.',
    boundaryNote:
      'Devices, subscriptions, and delivery status are managed elsewhere and are not shown here.',
    email: 'Service email',
    emailHint: 'Sign-in links and important security notices.',
    product: 'Product updates',
    productHint: 'New features and changes to Ecoma.',
    marketing: 'News and offers',
    marketingHint: 'Occasional email from us. Independent of the two above.',
  },

  privacy: {
    title: 'Privacy and personal data',
    description:
      'Ask us to give, correct, delete, restrict, or object to the use of your personal data.',
    export: 'Export my data',
    exportDescription: 'We send a copy of the data Ecoma holds about you.',
    correct: 'Correct my data',
    correctDescription: 'Tell us what is wrong and we will put it right.',
    delete: 'Delete my data',
    deleteDescription:
      'We remove your data and close the account. Some records must be kept by law.',
    restrict: 'Restrict processing',
    restrictDescription: 'We keep the data but stop using it while you ask.',
    object: 'Object to processing',
    objectDescription: 'Tell us to stop a particular use of your data.',
    submitTitle: 'Submit this request?',
    confirmRequired: 'We will reply to your verified address about the outcome.',
    submitted: 'Request received.',
    submittedBody:
      'This is a request, not a completed action. Its status below shows what has actually happened so far.',
    statusPending: 'Received',
    statusInProgress: 'In progress',
    statusCompleted: 'Completed',
    statusRejected: 'Not accepted',
    deadline: 'Response due',
    actionsHeading: 'Make a request',
    yourRequests: 'Your requests',
  },

  login: {
    title: 'Sign in to Ecoma',
    description: 'Enter your email address and we will send you a link. There is no password.',
    email: 'Email address',
    submit: 'Send me a sign-in link',
    submitting: 'Sending…',
    checkTitle: 'Check your inbox',
    checkBody: 'We sent a sign-in link to {email}. It expires shortly.',
    resend: 'Send it again',
    resendSent: 'Sent again.',
    changeEmail: 'Use a different email address',
    codeTitle: 'Enter your code',
    codeBody: 'Enter the code we sent to {email}.',
    codeLabel: 'Code',
    codeSubmit: 'Sign in',
    codeInvalid: 'That code is not correct.',
    codeAccepted: 'Code accepted.',
    noPasswordNote: 'Ecoma does not use passwords, so there is no password to enter or to recover.',
    errorTitle: 'We could not sign you in',
    errorBody: 'The sign-in link is no longer valid, or it was already used. Request a new one.',
  },

  loginContinue: {
    title: 'Finishing sign-in',
    body: 'One moment. We are completing the handover to the Ecoma authorisation service.',
    errorTitle: 'We could not finish signing you in',
    errorBody: 'The handover did not complete. Start again from the sign-in link.',
    retry: 'Start again',
  },

  consent: {
    title: 'Allow {client} to use your account?',
    description: 'Decide whether this application may act on your behalf.',
    requests: 'What it is asking for',
    riskTitle: 'Please check carefully',
    risk: 'This application is asking for broad access. Only continue if you trust it.',
    noClient: 'The requesting application is not identified.',
    noClientBody:
      'This sign-in request is missing, already used, or no longer valid. Start again from the application.',
    approve: 'Allow',
    deny: 'Deny',
    approving: 'Allowing…',
    denying: 'Denying…',
    loadFailed: 'This authorisation request could not be loaded.',
  },
} as const;
