# VHS tape — `aula whoami` against a real (sanitised) account.
#
#   vhs docs/demos/whoami.tape

Output docs/demos/whoami.gif

Set Shell bash
Set FontSize 14
Set Width 1000
Set Height 320
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set Padding 20
Set BorderRadius 10

Hide
Type 'aula() { cat docs/demos/fixtures/whoami-output.txt; }'
Enter
Type 'export PS1="❯ "'
Enter
Type 'clear'
Enter
Show

Type 'aula whoami'
Sleep 500ms
Enter
Sleep 5s
