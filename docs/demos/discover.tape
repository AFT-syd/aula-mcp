# VHS tape — show the discover-manifest shape an MCP agent gets.
# Uses a redacted fixture so we don't depend on a logged-in session.
#
#   vhs docs/demos/discover.tape

Output docs/demos/discover.gif

Set Shell zsh
Set FontSize 15
Set Width 1200
Set Height 720
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set Padding 18
Set BorderRadius 10

Type "cat docs/demos/fixtures/discover-manifest.json | jq ."
Sleep 400ms
Enter
Sleep 6s
