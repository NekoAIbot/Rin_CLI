import pytest
from calculator import add, subtract, multiply, divide


def test_add():
    assert add(2, 3) == 5 and add(-1, 1) == 0 and add(0, 0) == 0


def test_subtract():
    assert subtract(5, 3) == 2 and subtract(0, 5) == -5 and subtract(-1, -1) == 0


def test_multiply():
    assert multiply(3, 4) == 12 and multiply(-2, 3) == -6 and multiply(0, 99) == 0


def test_divide():
    assert divide(10, 2) == 5 and divide(7, 2) == 3.5 and divide(-9, 3) == -3


def test_divide_by_zero():
    with pytest.raises(ZeroDivisionError) as exc_info:
        divide(5, 0)
    assert str(exc_info.value) == 'Cannot divide by zero'
