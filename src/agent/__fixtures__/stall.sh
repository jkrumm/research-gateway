#!/bin/sh
# A stand-in for a wedged pdftotext: ignores every arg, never touches stdin or stdout, and
# just sits there — used to test the idle watchdog against a process that neither reads
# input nor produces output.
sleep 60
