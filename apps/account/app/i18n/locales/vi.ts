import type { AccountMessages } from './messages';

/**
 * Catalog tiếng Việt — **phải có đúng key của `en`**, đây là ràng buộc mà
 * `catalogs.spec.ts` kiểm.
 *
 * Vì sao không dùng `Record<MessageKey, string>` để bắt lệch key ngay lúc
 * compile: annotation đó kiểm *tương đối* (mọi key của `en` đều tồn tại) chứ
 * không kiểm *tuyệt đối* (không có key lạ nào lọt vào). Và phần chuyển ngữ thực
 * tế vẫn phải do test bảo đảm — hai file catalog là hai cây key, chúng trôi khỏi
 * nhau ngay khi ai đó thêm key mới ở `en` rồi quên cập nhật `vi`.
 *
 * Giá trị dùng `{name}`, `{email}`, `{count}` đúng như `en` — `vue-i18n`
 * nội suy theo tên placeholder, không phải theo vị trí.
 */
const messages: AccountMessages = {
  common: {
    save: 'Lưu thay đổi',
    cancel: 'Huỷ',
    remove: 'Xoá',
    add: 'Thêm',
    confirm: 'Xác nhận',
    back: 'Quay lại',
    close: 'Đóng',
    retry: 'Thử lại',
    dismiss: 'Bỏ qua',
    loading: 'Đang tải…',
    optional: 'không bắt buộc',
    simulated: 'Mô phỏng',
    unavailable: 'Không có',
    continue: 'Tiếp tục',
  },

  shell: {
    title: 'Tài khoản',
    skipToContent: 'Chuyển tới nội dung chính',
    languageLabel: 'Ngôn ngữ',
    languageHint: 'Đổi ngôn ngữ của mọi trang. Địa chỉ không thay đổi.',
    navLabel: 'Các mục tài khoản',
    mockBadge: 'Dữ liệu xem trước',
    mockNotice:
      'Mọi giá trị trên các trang này đến từ adapter xem trước cục bộ. Chưa có gì được lưu trên máy chủ Ecoma.',
  },

  nav: {
    personal: 'Thông tin cá nhân',
    emails: 'Địa chỉ email',
    security: 'Bảo mật',
    sessions: 'Phiên đăng nhập',
    applications: 'Ứng dụng đã kết nối',
    preferences: 'Tuỳ chọn cá nhân',
    notifications: 'Tuỳ chọn thông báo',
    privacy: 'Quyền riêng tư và dữ liệu cá nhân',
  },

  states: {
    errorTitle: 'Đã xảy ra lỗi',
    errorBody: 'Không tải được trang này. Hãy thử lại, hoặc liên hệ hỗ trợ nếu lỗi lặp lại.',
    saved: 'Đã lưu',
    saveFailed: 'Chưa lưu được',
    emptyPersonal: 'Chưa có thông tin hồ sơ.',
    emptyEmails: 'Chưa có địa chỉ email nào.',
    emptySessions: 'Không có phiên nào khác đang hoạt động.',
    emptyApplications: 'Chưa có ứng dụng nào được truy cập tài khoản của bạn.',
    emptyPrivacy: 'Bạn chưa gửi yêu cầu quyền riêng tư nào.',
  },

  profile: {
    title: 'Thông tin cá nhân',
    description: 'Tên và ảnh mà người khác nhìn thấy khi bạn dùng Ecoma.',
    displayName: 'Tên hiển thị',
    displayNameHint: 'Hiển thị thay cho địa chỉ email trong các ứng dụng bạn kết nối.',
    avatar: 'Ảnh đại diện',
    avatarHint: 'Adapter xem trước — chưa nối tính năng tải ảnh lên.',
    avatarAlt: 'Ảnh đại diện của {name}',
    avatarMissing: 'Chưa có ảnh đại diện.',
  },

  emails: {
    title: 'Địa chỉ email',
    description: 'Cần ít nhất một địa chỉ đã xác minh để đăng nhập. Ecoma không gửi mail tiếp thị.',
    address: 'Địa chỉ email',
    status: 'Trạng thái',
    statusPending: 'Chờ xác minh',
    statusVerified: 'Đã xác minh',
    add: 'Thêm địa chỉ email',
    addTitle: 'Thêm địa chỉ email',
    addDescription:
      'Chúng tôi gửi một liên kết xác minh. Địa chỉ chỉ dùng để đăng nhập được sau khi bạn xác nhận.',
    addSubmit: 'Gửi liên kết xác minh',
    addFailed: 'Không gửi được liên kết xác minh.',
    verify: 'Gửi lại liên kết',
    verifySent: 'Đã gửi liên kết xác minh.',
    removeTitle: 'Xoá địa chỉ email này?',
    removeDescription:
      'Địa chỉ này sẽ không dùng để đăng nhập được nữa, và thư gửi tới sẽ bị trả lại.',
    removeBlocked:
      'Đây là địa chỉ đã xác minh duy nhất của bạn. Hãy xác minh địa chỉ khác trước khi xoá.',
    removed: 'Đã xoá địa chỉ email.',
  },

  security: {
    title: 'Bảo mật',
    description:
      'Ecoma không dùng mật khẩu. Bạn đăng nhập bằng liên kết qua email, và có thể thêm lớp xác thực thứ hai để bảo vệ mạnh hơn.',
    noPasswordNote:
      'Ecoma không dùng mật khẩu, nên ở đây không có gì để thay đổi, đặt lại hay khôi phục.',
    passkeys: 'Passkey',
    passkeyHint:
      'Passkey mở phiên đăng nhập trên một thiết bị bằng sinh trắc học hoặc mã PIN của máy.',
    passkeyName: 'Tên thiết bị',
    passkeyNamePlaceholder: 'Ví dụ: Máy tính xách tay',
    passkeyAdd: 'Thêm passkey',
    passkeyRemoved: 'Đã gỡ passkey.',
    passkeyEmpty: 'Chưa có passkey nào.',
    totp: 'Ứng dụng xác thực',
    totpHint: 'Mã sáu chữ số từ ứng dụng xác thực, dùng khi bạn không mở được email.',
    totpEnroll: 'Bật ứng dụng xác thực',
    totpDisable: 'Tắt',
    recoveryCodes: 'Mã khôi phục',
    recoveryCodesHint: 'Mã dùng một lần, khi bạn mất cả email lẫn ứng dụng xác thực.',
    recoveryCodesRemaining: 'Còn {count} mã',
    recoveryCodesRegenerate: 'Tạo mã mới',
    recoveryCodesReveal: 'Hiện mã',
    recoveryCodesWarning: 'Các mã này chỉ hiện một lần. Hãy lưu lại ở nơi an toàn trước khi đóng.',
  },

  sessions: {
    title: 'Phiên đăng nhập',
    description: 'Các thiết bị đang đăng nhập vào tài khoản Ecoma của bạn.',
    current: 'Thiết bị này',
    device: 'Thiết bị',
    location: 'Vị trí ước lượng',
    lastSeen: 'Hoạt động gần nhất',
    signedInAt: 'Đăng nhập lúc',
    expiresAt: 'Hết hạn lúc',
    revoke: 'Đăng xuất',
    revokeTitle: 'Đăng xuất phiên này?',
    revokeDescription: 'Thiết bị đó sẽ phải đăng nhập lại bằng liên kết qua email.',
    revoked: 'Đã đăng xuất phiên.',
  },

  applications: {
    title: 'Ứng dụng đã kết nối',
    description: 'Các ứng dụng bạn đã cho phép được hành động thay mình.',
    grantedAt: 'Kết nối lúc',
    scopes: 'Ứng dụng này được phép',
    noScopes: 'Không có quyền cụ thể nào được yêu cầu.',
    revoke: 'Gỡ quyền truy cập',
    revokeTitle: 'Gỡ ứng dụng này?',
    revokeDescription:
      'Nó mất quyền truy cập ngay lập tức và các token đang có sẽ ngừng hoạt động.',
    revoked: 'Đã gỡ quyền truy cập.',
  },

  preferences: {
    title: 'Tuỳ chọn cá nhân',
    description: 'Cách Ecoma hiển thị ngày, giờ và màu sắc cho bạn.',
    language: 'Ngôn ngữ',
    timezone: 'Múi giờ',
    timezoneHint: 'Tên IANA, ví dụ Asia/Ho_Chi_Minh.',
    timezoneInvalid: 'Đó không phải tên múi giờ IANA hợp lệ.',
    colorMode: 'Chế độ màu',
    colorModeSystem: 'Theo hệ thống',
    colorModeLight: 'Sáng',
    colorModeDark: 'Tối',
    colorModeHint:
      'Chế độ màu chưa được áp dụng. Giá trị đã lưu sẽ có hiệu lực khi giao diện tối ra mắt.',
    saveFailed: 'Không lưu được tuỳ chọn của bạn, nên thay đổi đã không được giữ.',
  },

  notifications: {
    title: 'Tuỳ chọn thông báo',
    description:
      'Ecoma được gửi những loại tin nào. Đây là ý định của bạn, không phải danh sách thiết bị.',
    boundaryNote:
      'Thiết bị, đăng ký và trạng thái gửi được quản lý ở nơi khác và không hiển thị ở đây.',
    email: 'Email dịch vụ',
    emailHint: 'Liên kết đăng nhập và thông báo bảo mật quan trọng.',
    product: 'Cập nhật sản phẩm',
    productHint: 'Tính năng mới và thay đổi trong Ecoma.',
    marketing: 'Tin tức và ưu đãi',
    marketingHint: 'Thỉnh thoảng có email từ chúng tôi. Độc lập với hai mục trên.',
  },

  privacy: {
    title: 'Quyền riêng tư và dữ liệu cá nhân',
    description:
      'Yêu cầu chúng tôi cung cấp, sửa, xoá, hạn chế, hoặc phản đối việc dùng dữ liệu cá nhân của bạn.',
    export: 'Xuất dữ liệu của tôi',
    exportDescription: 'Chúng tôi gửi một bản sao dữ liệu Ecoma đang giữ về bạn.',
    correct: 'Sửa dữ liệu của tôi',
    correctDescription: 'Hãy cho chúng tôi biết chỗ nào sai, chúng tôi sẽ sửa.',
    delete: 'Xoá dữ liệu của tôi',
    deleteDescription:
      'Chúng tôi xoá dữ liệu và đóng tài khoản. Một số hồ sơ phải được giữ theo luật.',
    restrict: 'Hạn chế xử lý',
    restrictDescription: 'Chúng tôi giữ dữ liệu nhưng ngừng sử dụng trong lúc bạn yêu cầu.',
    object: 'Phản đối xử lý',
    objectDescription: 'Bảo chúng tôi dừng một cách sử dụng dữ liệu cụ thể của bạn.',
    submitTitle: 'Gửi yêu cầu này?',
    confirmRequired: 'Chúng tôi sẽ trả lời địa chỉ email đã xác minh của bạn về kết quả.',
    submitted: 'Đã nhận yêu cầu.',
    submittedBody:
      'Đây là yêu cầu, không phải hành động đã hoàn tất. Mục trạng thái bên dưới cho biết điều gì thực sự đã xảy ra.',
    statusPending: 'Đã nhận',
    statusInProgress: 'Đang xử lý',
    statusCompleted: 'Đã hoàn thành',
    statusRejected: 'Không được chấp nhận',
    deadline: 'Hạn trả lời',
    actionsHeading: 'Gửi một yêu cầu',
    yourRequests: 'Yêu cầu của bạn',
  },

  login: {
    title: 'Đăng nhập Ecoma',
    description: 'Nhập địa chỉ email, chúng tôi sẽ gửi cho bạn một liên kết. Không có mật khẩu.',
    email: 'Địa chỉ email',
    submit: 'Gửi cho tôi liên kết đăng nhập',
    submitting: 'Đang gửi…',
    checkTitle: 'Kiểm tra hộp thư',
    checkBody:
      'Chúng tôi đã gửi liên kết đăng nhập tới {email}. Liên kết hết hạn sau thời gian ngắn.',
    resend: 'Gửi lại',
    resendSent: 'Đã gửi lại.',
    changeEmail: 'Dùng địa chỉ email khác',
    codeTitle: 'Nhập mã của bạn',
    codeBody: 'Nhập mã chúng tôi đã gửi tới {email}.',
    codeLabel: 'Mã',
    codeSubmit: 'Đăng nhập',
    codeInvalid: 'Mã đó không đúng.',
    codeAccepted: 'Mã đã được xác nhận.',
    noPasswordNote:
      'Ecoma không dùng mật khẩu, nên không có mật khẩu nào để nhập hay để khôi phục.',
    errorTitle: 'Không đăng nhập được',
    errorBody: 'Liên kết đăng nhập không còn hợp lệ, hoặc đã dùng. Hãy yêu cầu một liên kết mới.',
  },

  loginContinue: {
    title: 'Đang hoàn tất đăng nhập',
    body: 'Vui lòng đợi. Chúng tôi đang bàn giao cho dịch vụ uỷ quyền Ecoma.',
    errorTitle: 'Không hoàn tất được đăng nhập',
    errorBody: 'Bàn giao không thành công. Hãy bắt đầu lại từ liên kết đăng nhập.',
    retry: 'Bắt đầu lại',
  },

  consent: {
    title: 'Cho phép {client} dùng tài khoản của bạn?',
    description: 'Quyết định ứng dụng này có được phép hành động thay bạn hay không.',
    requests: 'Ứng dụng đang xin gì',
    riskTitle: 'Vui lòng kiểm tra kỹ',
    risk: 'Ứng dụng này đang xin quyền rộng. Chỉ tiếp tục nếu bạn tin tưởng nó.',
    noClient: 'Ứng dụng đang yêu cầu không được nhận diện.',
    noClientBody:
      'Yêu cầu đăng nhập này đã thiếu, đã dùng, hoặc không còn hiệu lực. Hãy bắt đầu lại từ ứng dụng.',
    approve: 'Cho phép',
    deny: 'Từ chối',
    approving: 'Đang cho phép…',
    denying: 'Đang từ chối…',
    loadFailed: 'Không tải được yêu cầu uỷ quyền này.',
  },
};

export default messages;
