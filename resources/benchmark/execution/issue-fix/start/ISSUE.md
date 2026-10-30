# Daily sales report is wrong for some customers

Reported by support, all from the same customer:

1. Their Toronto office sees sales made just after midnight UTC counted on the previous
   day. Days in the report must be UTC calendar days, whatever time zone the server runs in.
2. Daily totals sometimes show amounts like 0.30000000000000004. Amounts are dollars, and
   daily totals must be exact to the cent.
3. One bad record (with a missing or unparseable `at`) made a day called "NaN-NaN-NaN"
   appear in the report. Records without a valid timestamp must be left out of the report.
