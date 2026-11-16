import os
import sys


class Account:
    def __init__(self, value=0):
        self._value = value

    @property
    def value(self):
        return self._value

    @value.setter
    def value(self, new_value):
        self._value = new_value


if sys.platform == "win32":
    def open_console():
        return os.system("start cmd")
else:
    def open_console():
        return os.system("x-terminal-emulator")


def main():
    return open_console()
