# VHS tape — `aula --help` overview.
#
# Render from repo root:
#   vhs docs/demos/help.tape
# Output:
#   docs/demos/help.gif

Output docs/demos/help.gif

Set Shell bash
Set FontSize 14
Set Width 1100
Set Height 700
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set Padding 20
Set BorderRadius 10

# Custom prompt so the GIF reads as a clean shell session.
Hide
Type 'export PS1="❯ "'
Enter
Type 'clear'
Enter
Show

Type 'bun apps/cli/src/index.ts --help'
Sleep 500ms
Enter
Sleep 5s
