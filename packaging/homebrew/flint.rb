# Homebrew cask for Flint (M10.3). Copy to a tap (0funct0ry/homebrew-flint, Casks/flint.rb).
# After each release, set `version` and `sha256` from the release's SHA256SUMS.
cask "flint" do
  version "0.1.0"
  sha256 "REPLACE_WITH_DMG_SHA256_FROM_SHA256SUMS"

  url "https://github.com/0funct0ry/flint/releases/download/v#{version}/Flint_#{version}_universal.dmg"
  name "Flint"
  desc "Local-first Markdown knowledge workspace"
  homepage "https://0funct0ry.github.io/flint/"

  depends_on macos: ">= :big_sur"

  app "Flint.app"
  # `flint` on PATH: Homebrew links the bundled binary directly.
  binary "#{appdir}/Flint.app/Contents/MacOS/flint"

  zap trash: "~/.config/flint"
end
