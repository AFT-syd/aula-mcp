# VHS tape — what an aula-mcp + Claude Code session looks like.
# Uses synthetic "Maja Eksempel" instead of a real child name; the
# weekplan content is illustrative.
#
#   vhs docs/demos/claude-code.tape

Output docs/demos/claude-code.gif

Set Shell bash
Set FontSize 14
Set Width 1100
Set Height 720
Set Theme "Catppuccin Mocha"
Set TypingSpeed 20ms
Set Padding 20
Set BorderRadius 10

# The fixture has the user's `❯ ...` prompt baked in so we never type
# Danish at a real shell prompt (would `command not found`). We load
# the file into a variable, `clear` to wipe any typed setup lines from
# the terminal, then echo just the content — that's the only thing
# visible when Show flips on.
Hide
Type 'export PS1=""'
Enter
Type 'OUT=$(cat docs/demos/fixtures/claude-session.txt)'
Enter
Type 'clear; printf "%s\n" "$OUT"'
Enter
Sleep 400ms
Show
Sleep 9s
