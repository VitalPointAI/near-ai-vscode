# Hardened twin: the security group admits one address only, and the bucket is encrypted at rest.
provider "aws" {
  region = "us-east-1"
}

resource "aws_security_group" "fixture" {
  name        = "fixture-sg"
  description = "restricted"

  ingress {
    description = "ssh from the operator"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["203.0.113.10/32"]
  }
}

resource "aws_s3_bucket" "exports" {
  bucket = "fixture-exports"
}

resource "aws_s3_bucket_server_side_encryption_configuration" "exports" {
  bucket = aws_s3_bucket.exports.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
