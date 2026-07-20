package auth

import (
	"bufio"
	"fmt"
	"os"

	"golang.org/x/crypto/bcrypt"
	"golang.org/x/term"
)

// HashPasswordCmd reads a password from stdin (no echo if TTY) and prints the bcrypt hash.
// Used to seed users.json — see server/README.md.
func HashPasswordCmd() {
	fd := int(os.Stdin.Fd())
	var pw []byte
	var err error

	if term.IsTerminal(fd) {
		fmt.Fprint(os.Stderr, "Password: ")
		pw, err = term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		if err != nil {
			fmt.Fprintln(os.Stderr, "read password:", err)
			os.Exit(1)
		}
	} else {
		s := bufio.NewScanner(os.Stdin)
		if s.Scan() {
			pw = s.Bytes()
		}
		if err := s.Err(); err != nil {
			fmt.Fprintln(os.Stderr, "read password:", err)
			os.Exit(1)
		}
	}

	if len(pw) == 0 {
		fmt.Fprintln(os.Stderr, "empty password")
		os.Exit(1)
	}

	hash, err := bcrypt.GenerateFromPassword(pw, 12)
	if err != nil {
		fmt.Fprintln(os.Stderr, "hash:", err)
		os.Exit(1)
	}
	fmt.Println(string(hash))
}
