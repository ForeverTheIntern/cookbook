from pricing.core import discount


def test_discount():
    assert discount(99) == 99
    assert discount(100) == 90
