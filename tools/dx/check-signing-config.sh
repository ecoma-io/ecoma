#!/bin/sh
# Gate commit signing cho `pre-commit`.
#
# Ở thời điểm pre-commit chạy, commit CHƯA tồn tại: `HEAD` vẫn trỏ tới commit
# trước đó, nên không có object nào để kiểm chữ ký. Thứ duy nhất hook này kiểm
# được là cấu hình — và cấu hình chính là nguyên nhân gốc khiến chữ ký bị mất:
# `git rebase`/`--amend` tái tạo commit bằng `commit.gpgsign` hiện hành, nên một
# lần drift cấu hình sẽ âm thầm bỏ chữ ký đi mà không báo lỗi.
#
# Gate chặn thật nằm ở `pre-push` (`pnpm dx commit-signing`), nơi commit đã tồn
# tại và chỉ những commit chưa lên remote mới bị kiểm. Script này chỉ là guard
# chặn sớm, và `--no-verify` bỏ qua được — điều đó được chấp nhận có chủ đích.
#
# Vì sao shell chứ không phải `pnpm dx commit-signing --check config`: `npx tsx`
# tốn ~1.1s khởi động ở mỗi lần commit, còn các lệnh `git config` dưới đây mất
# ~2ms. Policy nằm ở `tools/dx`; gate này chỉ là bản sao mỏng của phần cấu
# hình, để đổi lấy chi phí không đáng kể trên đường nóng của mỗi commit.

set -eu

problems=""

# `git config --get` trả exit 1 khi key chưa được set, nên giá trị rỗng được coi
# là unset — đúng như git tự hiểu: `commit.gpgsign` unset nghĩa là không ký.
gpgsign=$(git config --get commit.gpgsign || echo '')
if [ "$gpgsign" != "true" ]; then
  problems="${problems}  - commit.gpgsign must be \"true\" (current: ${gpgsign:-unset}); git would create unsigned commits.\n"
fi

format=$(git config --get gpg.format || echo '')
case "$format" in
  openpgp | x509 | ssh) ;;
  '') ;; # git mặc định openpgp, vẫn hợp lệ
  *)
    problems="${problems}  - gpg.format must be one of openpgp, x509, ssh (current: ${format}).\n"
    ;;
esac

# Chỉ `ssh` mới trỏ user.signingkey tới một file trên đĩa; `openpgp`/`x509` dùng
# key ID nên kiểm tồn tại ở hai format đó sẽ báo sai.
if [ "$format" = "ssh" ]; then
  key=$(git config --get user.signingkey || echo '')
  if [ -z "$key" ]; then
    problems="${problems}  - gpg.format is \"ssh\" but user.signingkey is not set.\n"
  elif [ ! -f "$key" ]; then
    problems="${problems}  - user.signingkey points at a missing file: ${key}\n"
  fi
fi

if [ -n "$problems" ]; then
  echo "Commit signing is not configured for this repository:" >&2
  printf "%b" "$problems" >&2
  exit 1
fi

echo "Commit signing config OK (gpg.format=${format:-openpgp})."