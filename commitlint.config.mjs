import nxScopes from '@commitlint/config-nx-scopes';

export default {
  extends: ['@commitlint/config-conventional', '@commitlint/config-nx-scopes'],
  plugins: [
    {
      rules: {
        'breaking-change-allowed-types': (parsed) => {
          const { type, notes, header } = parsed;

          const isBreakingChange =
            notes.some((note) => note.title === 'BREAKING CHANGE') ||
            /^[\w-]+(?:\([\w-]+\))?!:/u.test(header);

          const allowedTypes = ['feat', 'fix'];

          if (isBreakingChange && !allowedTypes.includes(type)) {
            return [
              false,
              `Breaking changes are only allowed for types: ${allowedTypes.join(', ')} (current type is '${type}').`,
            ];
          }

          return [true];
        },
        // Repo song ngữ nên AI agent dễ dán tiếng Việt vào message.
        // Thay vì whitelist ký tự cho phép (phải maintain corpus đặc biệt),
        // chặn tập con gây lỗi thực tế: mọi ký tự ngoài ASCII — bao gồm
        // toàn bộ tiếng Việt có dấu. Mục đích là chặn AI commit bằng ngôn ngữ
        // khác, không phải kiểm tra grammar tiếng Anh.
        // Rule này CHẶN KÝ TỰ, không phát hiện ngôn ngữ: nó không thể bắt
        // tiếng Việt không dấu (mọi ký tự đều ASCII). Vì vậy error message phải
        // tự mang lệnh sửa — nói rõ viết bằng tiếng Anh và cấm lách rule bằng
        // cách bỏ dấu — vì đó chính là cách lách phổ biến nhất.
        'ascii-only-message': (parsed) => {
          const text = [parsed.header, parsed.body, parsed.footer].filter(Boolean).join('\n');
          const bad = [...text].find((ch) => ch.codePointAt(0) > 0x7f);

          if (bad) {
            return [
              false,
              `Non-ASCII character '${bad}' found. Commit messages must be written in English. Do not work around this rule by removing accents or using Vietnamese without diacritics. Rewrite the entire commit message in English.`,
            ];
          }

          return [true];
        },
      },
    },
  ],
  rules: {
    'scope-enum': async (ctx) => [
      2,
      'always',
      // Scope `release` là ngoại lệ whitelist duy nhất: commit release do runner
      // tạo (#361, 02-delivery.md §7.2) mang scope `release` vì một batch có thể
      // chứa nhiều Nx project, trong khi scope của commit phải là một project
      // đơn. Mọi scope khác vẫn phải là một Nx project thật.
      [...(await nxScopes.utils.getProjects(ctx)), 'release'],
    ],
    'breaking-change-allowed-types': [2, 'always'],
    'ascii-only-message': [2, 'always'],
  },
};
