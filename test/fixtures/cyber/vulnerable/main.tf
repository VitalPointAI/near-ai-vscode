# Seeded weakness: the security group admits the whole internet on SSH and the bucket is not
# encrypted, so a copy of the database travels in plaintext.
provider "aws" {
  region = "us-east-1"
}

resource "aws_security_group" "fixture" {
  name        = "fixture-sg"
  description = "seeded misconfiguration"

  ingress {
    description = "ssh from anywhere"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_s3_bucket" "exports" {
  bucket = "fixture-exports"
}

resource "aws_s3_bucket_acl" "exports" {
  bucket = aws_s3_bucket.exports.id
  acl    = "public-read"
}
