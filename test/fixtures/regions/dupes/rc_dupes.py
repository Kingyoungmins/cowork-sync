"""rc_dupes: a valid base whose label keys repeat by construction."""
import os
import sys


class Account:
    """Account.value is defined twice: the getter and the setter."""

    def __init__(self, value=0):
        self._value = value

    @property
    def value(self):
        return self._value

    @value.setter
    def value(self, new_value):
        if new_value < 0:
            raise ValueError("negative")
        self._value = new_value


if sys.platform == "win32":
    def open_console():
        """Windows console."""
        return os.system("start powershell")
else:
    def open_console():
        """POSIX terminal."""
        return os.system("x-terminal-emulator -e sh")


def balance_of(account):
    return account.value
