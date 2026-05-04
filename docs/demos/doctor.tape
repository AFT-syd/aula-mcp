# VHS tape — `aula doctor` against a real (sanitised) account.
# Replays a captured-and-sanitised fixture so the GIF doesn't ship
# real children's names or institution codes.
#
#   vhs docs/demos/doctor.tape

Output docs/demos/doctor.gif

Set Shell bash
Set FontSize 13
Set Width 1100
Set Height 540
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set Padding 20
Set BorderRadius 10

Hide
# Shadow the real CLI with a function that replays a sanitised fixture.
# The GIF still types `aula doctor` and shows the same output a real
# logged-in session would print — minus the kids' names.
Type 'aula() { cat docs/demos/fixtures/doctor-output.txt; }'
Enter
Type 'export PS1="❯ "'
Enter
Type 'clear'
Enter
Show

Type 'aula doctor'
Sleep 500ms
Enter
Sleep 6s
